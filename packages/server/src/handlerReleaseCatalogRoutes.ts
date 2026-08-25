import type { ReleaseCatalog } from "@hot-updater/core";
import { canonicalizeAppVersion } from "@hot-updater/plugin-core";

import { requirePlatformParam, requireRouteParam } from "./handlerParameters";
import type { RouteHandler } from "./handlerTypes";

const CATALOG_CONTENT_TYPE =
  "application/vnd.hot-updater.release-catalog+json; version=1";
const ORIGIN_CACHE_TTL_MS = 5_000;
const ORIGIN_CACHE_MAX_ENTRIES = 128;

const privateNotFound = (): Response =>
  Response.json(
    { error: "Not found" },
    {
      status: 404,
      headers: { "cache-control": "private, no-store" },
    },
  );

const responseHash = async (body: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const catalogResponse = async (
  catalog: ReleaseCatalog | null,
  request: Request,
  clientAccessHeaderName: string,
): Promise<Response> => {
  if (catalog === null) return privateNotFound();
  const body = JSON.stringify(catalog);
  const etag = `"sha256:${await responseHash(body)}"`;
  const headers = {
    "cache-control": "public, max-age=0, s-maxage=5",
    "content-type": CATALOG_CONTENT_TYPE,
    etag,
    vary: `Accept-Encoding, ${clientAccessHeaderName}`,
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { headers, status: 304 });
  }
  return new Response(body, { headers, status: 200 });
};

export const createReleaseCatalogRouteHandlers = (
  authorityId: string,
  clientAccessHeaderName = "x-api-key",
): Record<string, RouteHandler> => {
  const cache = new Map<
    string,
    { readonly catalog: ReleaseCatalog; readonly expiresAt: number }
  >();
  const inFlight = new Map<string, Promise<ReleaseCatalog | null>>();
  const loadCatalog = async (
    key: string,
    load: () => Promise<ReleaseCatalog | null>,
  ): Promise<ReleaseCatalog | null> => {
    const cached = cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.catalog;
    }
    if (cached !== undefined) cache.delete(key);
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;

    const next = load().then((catalog) => {
      if (catalog !== null) {
        cache.set(key, {
          catalog,
          expiresAt: Date.now() + ORIGIN_CACHE_TTL_MS,
        });
        while (cache.size > ORIGIN_CACHE_MAX_ENTRIES) {
          const oldestKey = cache.keys().next().value as string | undefined;
          if (oldestKey === undefined) break;
          cache.delete(oldestKey);
        }
      }
      return catalog;
    });
    inFlight.set(key, next);
    try {
      return await next;
    } finally {
      inFlight.delete(key);
    }
  };

  return {
    appVersionReleaseCatalog: async (params, request, api) => {
      if (api.getReleaseCatalog === undefined) return privateNotFound();
      const rawAppVersion = requireRouteParam(params, "appVersion");
      const appVersion = canonicalizeAppVersion(rawAppVersion);
      if (appVersion === null || appVersion !== rawAppVersion) {
        return Response.json(
          { error: "Invalid app version" },
          { status: 400, headers: { "cache-control": "private, no-store" } },
        );
      }
      const input = {
        appVersion,
        authorityId,
        channelKey: requireRouteParam(params, "channelKey"),
        platform: requirePlatformParam(params),
        strategy: "APP_VERSION",
      } as const;
      return catalogResponse(
        await loadCatalog(`app-version:${JSON.stringify(input)}`, () =>
          api.getReleaseCatalog!(input),
        ),
        request,
        clientAccessHeaderName,
      );
    },

    fingerprintReleaseCatalog: async (params, request, api) => {
      if (api.getReleaseCatalog === undefined) return privateNotFound();
      const input = {
        authorityId,
        channelKey: requireRouteParam(params, "channelKey"),
        fingerprintHash: requireRouteParam(params, "fingerprintHash"),
        platform: requirePlatformParam(params),
        strategy: "FINGERPRINT",
      } as const;
      return catalogResponse(
        await loadCatalog(`fingerprint:${JSON.stringify(input)}`, () =>
          api.getReleaseCatalog!(input),
        ),
        request,
        clientAccessHeaderName,
      );
    },

    artifact: async (params, _request, api) => {
      if (api.getArtifactInfo === undefined) return privateNotFound();
      const info = await api.getArtifactInfo(
        requireRouteParam(params, "targetBundleId"),
        requireRouteParam(params, "currentBundleId"),
      );
      if (info === null) return privateNotFound();
      return new Response(JSON.stringify(info), {
        status: 200,
        headers: {
          "cache-control": "private, no-store",
          "content-type": "application/json",
        },
      });
    },
  };
};
