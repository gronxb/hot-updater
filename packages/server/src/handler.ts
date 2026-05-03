import type {
  AppUpdateInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  Platform,
} from "@hot-updater/core";
import type {
  DatabaseBundleQueryOptions,
  HotUpdaterContext,
} from "@hot-updater/plugin-core";

import { addRoute, createRouter, findRoute } from "./internalRouter";
import type { ChannelsResponse, PaginatedResult } from "./types";
import { HOT_UPDATER_SERVER_VERSION } from "./version";

// Narrow API surface needed by the handler to avoid circular types
export interface HandlerAPI<TContext = unknown> {
  getAppUpdateInfo: (
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<AppUpdateInfo | null>;
  getBundleById: (
    id: string,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Bundle | null>;
  getBundles: (
    options: DatabaseBundleQueryOptions,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<PaginatedResult>;
  insertBundle: (
    bundle: Bundle,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<void>;
  updateBundleById: (
    bundleId: string,
    bundle: Partial<Bundle>,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<void>;
  deleteBundleById: (
    bundleId: string,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<void>;
  getChannels: (context?: HotUpdaterContext<TContext>) => Promise<string[]>;
}

export interface HandlerOptions {
  /**
   * Base path for all routes
   * @default "/api"
   */
  basePath?: string;
  routes?: HandlerRoutes;
}

export interface HandlerRoutes {
  /**
   * Controls whether update-check routes are mounted.
   * @default true
   */
  updateCheck?: boolean;
  /**
   * Controls whether the `/version` endpoint is mounted.
   * Useful for diagnostics and lightweight health/version checks.
   * @default true
   */
  version?: boolean;
  /**
   * Controls whether bundle management routes are mounted.
   * This includes `/api/bundles*`, which are used by the
   * CLI `standaloneRepository` plugin.
   * @default true
   */
  bundles?: boolean;
}

type RouteHandler<TContext = unknown> = (
  params: Record<string, string>,
  request: Request,
  api: HandlerAPI<TContext>,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response>;

class HandlerBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandlerBadRequestError";
  }
}

// Route handlers
const handleVersion: RouteHandler = async () => {
  return new Response(JSON.stringify({ version: HOT_UPDATER_SERVER_VERSION }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const decodeMaybe = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const isPlatform = (value: string): value is Platform => {
  return value === "ios" || value === "android";
};

const requireRouteParam = (
  params: Record<string, string>,
  key: string,
): string => {
  const value = params[key];
  if (!value) {
    throw new HandlerBadRequestError(`Missing route parameter: ${key}`);
  }

  return value;
};

const parseBooleanSearchParam = (
  url: URL,
  key: string,
): boolean | undefined => {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new HandlerBadRequestError(
    `The '${key}' query parameter must be 'true' or 'false'.`,
  );
};

const parseNullableStringSearchParam = (
  url: URL,
  key: string,
): string | null | undefined => {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }

  return value === "null" ? null : value;
};

const parseStringArraySearchParam = (url: URL, key: string) => {
  const values = url.searchParams.getAll(key);
  return values.length > 0 ? values : undefined;
};

const requirePlatformParam = (params: Record<string, string>): Platform => {
  const platform = requireRouteParam(params, "platform");

  if (!isPlatform(platform)) {
    throw new HandlerBadRequestError(
      `Invalid platform: ${platform}. Expected 'ios' or 'android'.`,
    );
  }

  return platform;
};

type BundlePatchPayload = Partial<Bundle> & {
  id?: string;
};

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

const handleFingerprintUpdateWithCohort: RouteHandler = async (
  params,
  _request,
  api,
  context,
) => {
  const platform = requirePlatformParam(params);
  const fingerprintHash = requireRouteParam(params, "fingerprintHash");
  const channel = requireRouteParam(params, "channel");
  const minBundleId = requireRouteParam(params, "minBundleId");
  const bundleId = requireRouteParam(params, "bundleId");

  const updateInfo = await api.getAppUpdateInfo(
    {
      _updateStrategy: "fingerprint",
      platform,
      fingerprintHash,
      channel,
      minBundleId,
      bundleId,
      cohort: decodeMaybe(params.cohort),
    },
    context,
  );

  return new Response(JSON.stringify(updateInfo), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleAppVersionUpdateWithCohort: RouteHandler = async (
  params,
  _request,
  api,
  context,
) => {
  const platform = requirePlatformParam(params);
  const appVersion = requireRouteParam(params, "appVersion");
  const channel = requireRouteParam(params, "channel");
  const minBundleId = requireRouteParam(params, "minBundleId");
  const bundleId = requireRouteParam(params, "bundleId");

  const updateInfo = await api.getAppUpdateInfo(
    {
      _updateStrategy: "appVersion",
      platform,
      appVersion,
      channel,
      minBundleId,
      bundleId,
      cohort: decodeMaybe(params.cohort),
    },
    context,
  );

  return new Response(JSON.stringify(updateInfo), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleGetBundle: RouteHandler = async (
  params,
  _request,
  api,
  context,
) => {
  const bundleId = requireRouteParam(params, "id");
  const bundle = await api.getBundleById(bundleId, context);

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
};

const handleGetBundles: RouteHandler = async (
  _params,
  request,
  api,
  context,
) => {
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel") ?? undefined;
  const platform = url.searchParams.get("platform");
  const limit = Number(url.searchParams.get("limit")) || 50;
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
        ...(idEq || idGt || idGte || idLt || idLte || (idIn && idIn.length > 0)
          ? {
              id: {
                ...(idEq && { eq: idEq }),
                ...(idGt && { gt: idGt }),
                ...(idGte && { gte: idGte }),
                ...(idLt && { lt: idLt }),
                ...(idLte && { lte: idLte }),
                ...(idIn && idIn.length > 0 && { in: idIn }),
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
      cursor:
        after || before
          ? {
              after,
              before,
            }
          : undefined,
    },
    context,
  );

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleCreateBundles: RouteHandler = async (
  _params,
  request,
  api,
  context,
) => {
  const body = await request.json();
  const bundles = Array.isArray(body) ? body : [body];

  for (const bundle of bundles) {
    await api.insertBundle(bundle as Bundle, context);
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
};

const handleUpdateBundle: RouteHandler = async (
  params,
  request,
  api,
  context,
) => {
  const bundleId = requireRouteParam(params, "id");
  const body = await request.json();
  const payload = Array.isArray(body) ? body[0] : body;
  const bundlePatch = requireBundlePatchPayload(payload, bundleId);
  await api.updateBundleById(bundleId, bundlePatch, context);

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleDeleteBundle: RouteHandler = async (
  params,
  _request,
  api,
  context,
) => {
  const bundleId = requireRouteParam(params, "id");
  await api.deleteBundleById(bundleId, context);

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleGetChannels: RouteHandler = async (
  _params,
  _request,
  api,
  context,
) => {
  const channels = await api.getChannels(context);
  const response: ChannelsResponse = {
    data: {
      channels,
    },
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

// Route handlers map
const routes: Record<string, RouteHandler<any>> = {
  version: handleVersion,
  fingerprintUpdateWithCohort: handleFingerprintUpdateWithCohort,
  appVersionUpdateWithCohort: handleAppVersionUpdateWithCohort,
  getBundle: handleGetBundle,
  getBundles: handleGetBundles,
  createBundles: handleCreateBundles,
  updateBundle: handleUpdateBundle,
  deleteBundle: handleDeleteBundle,
  getChannels: handleGetChannels,
};

/**
 * Creates a Web Standard Request handler for Hot Updater API
 * This handler is framework-agnostic and works with any runtime that
 * supports standard Request/Response objects.
 */
export function createHandler<TContext = unknown>(
  api: HandlerAPI<TContext>,
  options: HandlerOptions = {},
): (
  request: Request,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response> {
  const basePath = options.basePath ?? "/api";
  const updateCheckEnabled = options.routes?.updateCheck ?? true;
  const versionEnabled = options.routes?.version ?? true;
  const bundlesEnabled = options.routes?.bundles ?? true;

  // Create and configure router
  const router = createRouter();

  // Register routes
  if (versionEnabled) {
    addRoute(router, "GET", "/version", "version");
  }

  if (updateCheckEnabled) {
    addRoute(
      router,
      "GET",
      "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId",
      "fingerprintUpdateWithCohort",
    );
    addRoute(
      router,
      "GET",
      "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId/:cohort",
      "fingerprintUpdateWithCohort",
    );
    addRoute(
      router,
      "GET",
      "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId",
      "appVersionUpdateWithCohort",
    );
    addRoute(
      router,
      "GET",
      "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId/:cohort",
      "appVersionUpdateWithCohort",
    );
  }

  if (bundlesEnabled) {
    addRoute(router, "GET", "/api/bundles/channels", "getChannels");
    addRoute(router, "GET", "/api/bundles/:id", "getBundle");
    addRoute(router, "GET", "/api/bundles", "getBundles");
    addRoute(router, "POST", "/api/bundles", "createBundles");
    addRoute(router, "PATCH", "/api/bundles/:id", "updateBundle");
    addRoute(router, "DELETE", "/api/bundles/:id", "deleteBundle");
  }

  return async (
    request: Request,
    context?: HotUpdaterContext<TContext>,
  ): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // Remove base path from pathname
      const routePath = path.startsWith(basePath)
        ? path.slice(basePath.length)
        : path;

      // Find matching route
      const match = findRoute(router, method, routePath);

      if (!match) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Get handler and execute
      const handler = routes[match.data as string] as RouteHandler<TContext>;
      if (!handler) {
        return new Response(JSON.stringify({ error: "Handler not found" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      return await handler(match.params || {}, request, api, context);
    } catch (error) {
      if (error instanceof HandlerBadRequestError) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      console.error("Hot Updater handler error:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  };
}
