import type {
  AppUpdateInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
} from "@hot-updater/core";
import type { DeviceEvent, RolloutStats } from "@hot-updater/plugin-core";
import { addRoute, createRouter, findRoute } from "rou3";
import type { PaginationInfo } from "./types";

declare const __VERSION__: string;

// Narrow API surface needed by the handler to avoid circular types
export interface HandlerAPI {
  getAppUpdateInfo: (
    args: AppVersionGetBundlesArgs | FingerprintGetBundlesArgs,
  ) => Promise<AppUpdateInfo | null>;
  getBundleById: (id: string) => Promise<Bundle | null>;
  getBundles: (options: {
    where?: { channel?: string; platform?: string };
    limit: number;
    offset: number;
  }) => Promise<{ data: Bundle[]; pagination: PaginationInfo }>;
  insertBundle: (bundle: Bundle) => Promise<void>;
  deleteBundleById: (bundleId: string) => Promise<void>;
  getChannels: () => Promise<string[]>;

  trackDeviceEvent?: (event: DeviceEvent) => Promise<void>;
  getRolloutStats?: (bundleId: string) => Promise<RolloutStats>;
}

export interface HandlerOptions {
  /**
   * Base path for all routes
   * @default "/api"
   */
  basePath?: string;
}

type RouteHandler = (
  params: Record<string, string>,
  request: Request,
  api: HandlerAPI,
) => Promise<Response>;

// Route handlers
const handleVersion: RouteHandler = async () => {
  return new Response(JSON.stringify({ version: __VERSION__ }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleFingerprintUpdate: RouteHandler = async (params, _request, api) => {
  const updateInfo = await api.getAppUpdateInfo({
    _updateStrategy: "fingerprint",
    platform: params.platform as "ios" | "android",
    fingerprintHash: params.fingerprintHash,
    channel: params.channel,
    minBundleId: params.minBundleId,
    bundleId: params.bundleId,
  });

  return new Response(JSON.stringify(updateInfo), {
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

const handleFingerprintUpdateWithDeviceId: RouteHandler = async (
  params,
  _request,
  api,
) => {
  const updateInfo = await api.getAppUpdateInfo({
    _updateStrategy: "fingerprint",
    platform: params.platform as "ios" | "android",
    fingerprintHash: params.fingerprintHash,
    channel: params.channel,
    minBundleId: params.minBundleId,
    bundleId: params.bundleId,
    deviceId: decodeMaybe(params.deviceId),
  });

  return new Response(JSON.stringify(updateInfo), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleAppVersionUpdate: RouteHandler = async (params, _request, api) => {
  const updateInfo = await api.getAppUpdateInfo({
    _updateStrategy: "appVersion",
    platform: params.platform as "ios" | "android",
    appVersion: params.appVersion,
    channel: params.channel,
    minBundleId: params.minBundleId,
    bundleId: params.bundleId,
  });

  return new Response(JSON.stringify(updateInfo), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleAppVersionUpdateWithDeviceId: RouteHandler = async (
  params,
  _request,
  api,
) => {
  const updateInfo = await api.getAppUpdateInfo({
    _updateStrategy: "appVersion",
    platform: params.platform as "ios" | "android",
    appVersion: params.appVersion,
    channel: params.channel,
    minBundleId: params.minBundleId,
    bundleId: params.bundleId,
    deviceId: decodeMaybe(params.deviceId),
  });

  return new Response(JSON.stringify(updateInfo), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleGetBundle: RouteHandler = async (params, _request, api) => {
  const bundle = await api.getBundleById(params.id);

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

const handleGetBundles: RouteHandler = async (_params, request, api) => {
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel") ?? undefined;
  const platform = url.searchParams.get("platform") ?? undefined;
  const limit = Number(url.searchParams.get("limit")) || 50;
  const offset = Number(url.searchParams.get("offset")) || 0;

  const result = await api.getBundles({
    where: {
      ...(channel && { channel }),
      ...(platform && { platform }),
    },
    limit,
    offset,
  });

  return new Response(JSON.stringify(result.data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleCreateBundles: RouteHandler = async (_params, request, api) => {
  const body = await request.json();
  const bundles = Array.isArray(body) ? body : [body];

  for (const bundle of bundles) {
    await api.insertBundle(bundle as Bundle);
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
};

const handleDeleteBundle: RouteHandler = async (params, _request, api) => {
  await api.deleteBundleById(params.id);

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleGetChannels: RouteHandler = async (_params, _request, api) => {
  const channels = await api.getChannels();

  return new Response(JSON.stringify({ channels }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleTrackEvent: RouteHandler = async (_params, request, api) => {
  if (!api.trackDeviceEvent) {
    return new Response(JSON.stringify({ error: "Tracking not supported" }), {
      status: 501,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await request.json()) as Partial<DeviceEvent>;
    const {
      deviceId,
      bundleId,
      eventType,
      platform,
      appVersion,
      channel,
      metadata,
    } = body;

    if (!deviceId || !bundleId || !eventType || !platform || !channel) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (eventType !== "PROMOTED" && eventType !== "RECOVERED") {
      return new Response(JSON.stringify({ error: "Invalid eventType" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (platform !== "ios" && platform !== "android") {
      return new Response(JSON.stringify({ error: "Invalid platform" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    await api.trackDeviceEvent({
      deviceId,
      bundleId,
      eventType,
      platform,
      appVersion,
      channel,
      metadata,
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Track event error:", error);
    return new Response(JSON.stringify({ error: "Failed to track event" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

const handleGetRolloutStats: RouteHandler = async (params, _request, api) => {
  if (!api.getRolloutStats) {
    return new Response(
      JSON.stringify({ error: "Rollout stats not supported" }),
      {
        status: 501,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const stats = await api.getRolloutStats(params.bundleId);
    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Get rollout stats error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to get rollout stats" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// Route handlers map
const routes: Record<string, RouteHandler> = {
  version: handleVersion,
  fingerprintUpdate: handleFingerprintUpdate,
  fingerprintUpdateWithDeviceId: handleFingerprintUpdateWithDeviceId,
  appVersionUpdate: handleAppVersionUpdate,
  appVersionUpdateWithDeviceId: handleAppVersionUpdateWithDeviceId,
  getBundle: handleGetBundle,
  getBundles: handleGetBundles,
  createBundles: handleCreateBundles,
  deleteBundle: handleDeleteBundle,
  getChannels: handleGetChannels,
  trackEvent: handleTrackEvent,
  getRolloutStats: handleGetRolloutStats,
};

/**
 * Creates a Web Standard Request handler for Hot Updater API
 * This handler is framework-agnostic and works with any framework
 * that supports Web Standard Request/Response (Hono, Elysia, etc.)
 */
export function createHandler(
  api: HandlerAPI,
  options: HandlerOptions = {},
): (request: Request) => Promise<Response> {
  const basePath = options.basePath ?? "/api";

  // Create and configure router
  const router = createRouter();

  // Register routes
  addRoute(router, "GET", "/version", "version");
  addRoute(
    router,
    "GET",
    "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId",
    "fingerprintUpdate",
  );
  addRoute(
    router,
    "GET",
    "/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId/:deviceId",
    "fingerprintUpdateWithDeviceId",
  );
  addRoute(
    router,
    "GET",
    "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId",
    "appVersionUpdate",
  );
  addRoute(
    router,
    "GET",
    "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId/:deviceId",
    "appVersionUpdateWithDeviceId",
  );
  addRoute(router, "GET", "/api/bundles/channels", "getChannels");
  addRoute(router, "GET", "/api/bundles/:id", "getBundle");
  addRoute(router, "GET", "/api/bundles", "getBundles");
  addRoute(router, "POST", "/api/bundles", "createBundles");
  addRoute(router, "DELETE", "/api/bundles/:id", "deleteBundle");
  addRoute(router, "POST", "/api/track", "trackEvent");
  addRoute(
    router,
    "GET",
    "/api/bundles/:bundleId/rollout-stats",
    "getRolloutStats",
  );

  return async (request: Request): Promise<Response> => {
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
      const handler = routes[match.data as string];
      if (!handler) {
        return new Response(JSON.stringify({ error: "Handler not found" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      return await handler(match.params || {}, request, api);
    } catch (error) {
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
