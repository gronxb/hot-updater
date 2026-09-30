import type { ReleaseCatalog } from "@hot-updater/core";
import { canonicalizeAppVersion } from "@hot-updater/plugin-core";

import { requirePlatformParam, requireRouteParam } from "./handlerParameters";
import type { RouteHandler } from "./handlerTypes";

const CATALOG_CONTENT_TYPE =
  "application/vnd.hot-updater.release-catalog+json; version=1";
const ARTIFACT_CONTENT_TYPE =
  "application/vnd.hot-updater.artifact+json; version=1";
const ORIGIN_CACHE_TTL_MS = 5_000;
const ORIGIN_CACHE_MAX_ENTRIES = 128;
/** Marks the 404 of a scope that has no catalog. */
const NO_CATALOG_HEADER = "x-hot-updater-catalog";
/** A shared cache keeps a catalog, or a scope's lack of one, five seconds. */
const CATALOG_CACHE_CONTROL = "public, max-age=0, s-maxage=5";

const privateNotFound = (): Response =>
  Response.json(
    { error: "Not found" },
    {
      status: 404,
      headers: { "cache-control": "private, no-store" },
    },
  );

/**
 * A scope with no catalog yet, such as a store version before its first
 * OTA release: cached like a catalog, so its update checks don't all reach
 * the origin, and it holds nothing an API key protects. The header tells it
 * apart from a 404 for a wrong URL: clients read it as "no update", and
 * doctor as a live catalog route.
 */
const missingCatalog = (): Response =>
  Response.json(
    { error: "Not found" },
    {
      status: 404,
      headers: {
        "cache-control": CATALOG_CACHE_CONTROL,
        vary: "Accept-Encoding",
        [NO_CATALOG_HEADER]: "none",
      },
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
): Promise<Response> => {
  if (catalog === null) return missingCatalog();
  const body = JSON.stringify(catalog);
  const etag = `"sha256:${await responseHash(body)}"`;
  const headers = {
    "cache-control": CATALOG_CACHE_CONTROL,
    "content-type": CATALOG_CONTENT_TYPE,
    etag,
    vary: "Accept-Encoding",
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { headers, status: 304 });
  }
  return new Response(body, { headers, status: 200 });
};

export const createReleaseCatalogRouteHandlers = (): Record<
  string,
  RouteHandler
> => {
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
    appVersionReleaseCatalog: async (params, request, { core }) => {
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
        channelKey: requireRouteParam(params, "channelKey"),
        platform: requirePlatformParam(params),
        strategy: "APP_VERSION",
      } as const;
      return catalogResponse(
        await loadCatalog(`app-version:${JSON.stringify(input)}`, () =>
          core.getReleaseCatalog(input),
        ),
        request,
      );
    },

    fingerprintReleaseCatalog: async (params, request, { core }) => {
      const input = {
        channelKey: requireRouteParam(params, "channelKey"),
        fingerprintHash: requireRouteParam(params, "fingerprintHash"),
        platform: requirePlatformParam(params),
        strategy: "FINGERPRINT",
      } as const;
      return catalogResponse(
        await loadCatalog(`fingerprint:${JSON.stringify(input)}`, () =>
          core.getReleaseCatalog(input),
        ),
        request,
      );
    },

    artifactV1: async (params, _request, { core }) => {
      const info = await core.getArtifactInfo(
        requireRouteParam(params, "targetBundleId"),
        requireRouteParam(params, "currentBundleId"),
        1,
      );
      if (info === null) return privateNotFound();
      return new Response(JSON.stringify(info), {
        status: 200,
        headers: {
          "cache-control": "private, no-store",
          "content-type": ARTIFACT_CONTENT_TYPE,
        },
      });
    },
  };
};
