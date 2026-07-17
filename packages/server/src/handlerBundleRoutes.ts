import type { Bundle } from "@hot-updater/core";

import { HandlerBadRequestError } from "./handlerErrors";
import {
  isPlatform,
  parseBooleanSearchParam,
  parseNullableStringSearchParam,
  parsePositiveIntegerSearchParam,
  parseStringArraySearchParam,
  requireRouteParam,
} from "./handlerParameters";
import type { RouteHandler } from "./handlerTypes";
import type { ChannelsResponse } from "./types";

const BUNDLE_LIST_BOUNDS = { defaultValue: 50, maxValue: 100 } as const;

type BundlePatchPayload = Partial<Bundle> & { readonly id?: string };

const requireBundlePatchPayload = (
  payload: unknown,
  bundleId: string,
): Partial<Bundle> => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HandlerBadRequestError("Invalid bundle payload");
  }
  const bundlePatch = payload as BundlePatchPayload;
  if (bundlePatch.id !== undefined && bundlePatch.id !== bundleId) {
    throw new HandlerBadRequestError("Bundle id mismatch");
  }
  const { id: _ignoredId, ...rest } = bundlePatch;
  return rest;
};

export const createBundleRouteHandlers = <TContext>(): Record<
  string,
  RouteHandler<TContext>
> => ({
  getBundle: async (params, _request, api, context) => {
    const bundle = await api.getBundleById(
      requireRouteParam(params, "id"),
      context,
    );
    if (!bundle) {
      return new Response(JSON.stringify({ error: "Bundle not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(bundle), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },

  getBundles: async (_params, request, api, context) => {
    const url = new URL(request.url);
    const channel = url.searchParams.get("channel") ?? undefined;
    const platform = url.searchParams.get("platform");
    const limit = parsePositiveIntegerSearchParam(
      url,
      "limit",
      BUNDLE_LIST_BOUNDS,
    );
    const pageParam = url.searchParams.get("page");
    const offset = url.searchParams.get("offset");
    const after = url.searchParams.get("after") ?? undefined;
    const before = url.searchParams.get("before") ?? undefined;
    const enabled = parseBooleanSearchParam(url, "enabled");
    const targetAppVersion = parseNullableStringSearchParam(
      url,
      "targetAppVersion",
    );
    const targetAppVersionIn = parseStringArraySearchParam(
      url,
      "targetAppVersionIn",
    );
    const targetAppVersionNotNull = parseBooleanSearchParam(
      url,
      "targetAppVersionNotNull",
    );
    const fingerprintHash = parseNullableStringSearchParam(
      url,
      "fingerprintHash",
    );
    const idEq = url.searchParams.get("idEq") ?? undefined;
    const idGt = url.searchParams.get("idGt") ?? undefined;
    const idGte = url.searchParams.get("idGte") ?? undefined;
    const idLt = url.searchParams.get("idLt") ?? undefined;
    const idLte = url.searchParams.get("idLte") ?? undefined;
    const idIn = parseStringArraySearchParam(url, "idIn");
    const page =
      pageParam === null
        ? undefined
        : Number.isInteger(Number(pageParam)) && Number(pageParam) > 0
          ? Number(pageParam)
          : null;
    if (offset !== null) {
      throw new HandlerBadRequestError(
        "The 'offset' query parameter has been removed. Use 'after' or 'before' cursor pagination instead.",
      );
    }
    if (page === null) {
      throw new HandlerBadRequestError(
        "The 'page' query parameter must be a positive integer.",
      );
    }
    if (platform !== null && !isPlatform(platform)) {
      throw new HandlerBadRequestError(
        `Invalid platform: ${platform}. Expected 'ios' or 'android'.`,
      );
    }
    const result = await api.getBundles(
      {
        where: {
          ...(channel && { channel }),
          ...(platform && { platform }),
          ...(enabled !== undefined && { enabled }),
          ...(idEq || idGt || idGte || idLt || idLte || idIn?.length
            ? {
                id: {
                  ...(idEq && { eq: idEq }),
                  ...(idGt && { gt: idGt }),
                  ...(idGte && { gte: idGte }),
                  ...(idLt && { lt: idLt }),
                  ...(idLte && { lte: idLte }),
                  ...(idIn?.length && { in: idIn }),
                },
              }
            : {}),
          ...(targetAppVersion !== undefined && { targetAppVersion }),
          ...(targetAppVersionIn && { targetAppVersionIn }),
          ...(targetAppVersionNotNull !== undefined && {
            targetAppVersionNotNull,
          }),
          ...(fingerprintHash !== undefined && { fingerprintHash }),
        },
        limit,
        page,
        cursor: after || before ? { after, before } : undefined,
      },
      context,
    );
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },

  createBundles: async (_params, request, api, context) => {
    const body = await request.json();
    const bundles = Array.isArray(body) ? body : [body];
    for (const bundle of bundles) {
      await api.insertBundle(bundle as Bundle, context);
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  },

  updateBundle: async (params, request, api, context) => {
    const bundleId = requireRouteParam(params, "id");
    const body = await request.json();
    const payload = Array.isArray(body) ? body[0] : body;
    await api.updateBundleById(
      bundleId,
      requireBundlePatchPayload(payload, bundleId),
      context,
    );
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },

  deleteBundle: async (params, _request, api, context) => {
    await api.deleteBundleById(requireRouteParam(params, "id"), context);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },

  getChannels: async (_params, _request, api, context) => {
    const response: ChannelsResponse = {
      data: { channels: await api.getChannels(context) },
    };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});
