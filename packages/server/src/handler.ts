import type {
  AppUpdateInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
} from "@hot-updater/core";
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
  updateBundleById: (bundleId: string, data: Partial<Bundle>) => Promise<void>;
  deleteBundleById: (bundleId: string) => Promise<void>;
  deleteStorageFile?: (storageUri: string) => Promise<void>;
  getChannels: () => Promise<string[]>;
}

export interface HandlerOptions {
  /**
   * Base path for all routes
   * @default "/api"
   */
  basePath?: string;
  /**
   * Console configuration
   * If provided, enables /config endpoint
   */
  console?: {
    /**
     * Git repository URL for commit history links
     */
    gitUrl?: string;
  };
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

  // Calculate pagination info
  const total = result.pagination?.total ?? result.data?.length ?? 0;
  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;
  const hasPreviousPage = currentPage > 1;
  const hasNextPage = currentPage < totalPages;

  return new Response(
    JSON.stringify({
      data: result.data ?? [],
      pagination: {
        total,
        totalPages,
        currentPage,
        limit,
        offset,
        hasPreviousPage,
        hasNextPage,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
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

const handleUpdateBundle: RouteHandler = async (params, request, api) => {
  const bundleId = params.id;
  if (!bundleId) {
    return new Response(
      JSON.stringify({ error: "Target bundle ID is required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const partialBundle = (await request.json()) as Partial<Bundle>;
    await api.updateBundleById(bundleId, partialBundle);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error during bundle update:", error);
    const message =
      error && typeof error === "object" && "message" in error
        ? error.message
        : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

const handleDeleteBundle: RouteHandler = async (params, _request, api) => {
  try {
    const bundleId = params.id;
    const deleteBundle = await api.getBundleById(bundleId);
    if (!deleteBundle) {
      return new Response(JSON.stringify({ error: "Bundle not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    await api.deleteBundleById(bundleId);
    if (api.deleteStorageFile) {
      await api.deleteStorageFile(deleteBundle.storageUri);
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error during bundle deletion:", error);
    const message =
      error && typeof error === "object" && "message" in error
        ? error.message
        : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

const handleGetChannels: RouteHandler = async (_params, _request, api) => {
  const channels = await api.getChannels();

  return new Response(JSON.stringify(channels), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

// Route handlers map
const routes: Record<string, RouteHandler> = {
  version: handleVersion,
  fingerprintUpdate: handleFingerprintUpdate,
  appVersionUpdate: handleAppVersionUpdate,
  getBundle: handleGetBundle,
  getBundles: handleGetBundles,
  createBundles: handleCreateBundles,
  updateBundle: handleUpdateBundle,
  deleteBundle: handleDeleteBundle,
  getChannels: handleGetChannels,
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
  // Normalize basePath: "/" is treated as "" (no prefix to strip)
  const normalizedBasePath = basePath === "/" ? "" : basePath;
  const consoleOpts = options.console;

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
    "/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId",
    "appVersionUpdate",
  );
  addRoute(router, "GET", "/api/bundles/channels", "getChannels");
  addRoute(router, "GET", "/api/bundles/:id", "getBundle");
  addRoute(router, "GET", "/api/bundles", "getBundles");
  addRoute(router, "POST", "/api/bundles", "createBundles");
  addRoute(router, "PATCH", "/api/bundles/:id", "updateBundle");
  addRoute(router, "DELETE", "/api/bundles/:id", "deleteBundle");

  // Console-specific routes
  if (consoleOpts) {
    addRoute(router, "GET", "/config", "config");
  }

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // Remove base path from pathname
      const routePath = path.startsWith(normalizedBasePath)
        ? path.slice(normalizedBasePath.length)
        : path;

      // Handle /config route separately (needs options, not api)
      if (routePath === "/config" && method === "GET" && consoleOpts) {
        return new Response(JSON.stringify({ console: consoleOpts }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

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
