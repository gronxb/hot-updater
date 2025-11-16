import type {
  AppUpdateInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
} from "@hot-updater/core";
import { readFile } from "fs/promises";
import { join } from "path";
import { addRoute, createRouter, findRoute } from "rou3";
import { fileURLToPath } from "url";
import type { PaginationInfo } from "./types";

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
}

export interface HandlerOptions {
  /**
   * Base path for all routes
   * @default "/api"
   */
  basePath?: string;
  /**
   * Enable console UI integration
   * When enabled, serves the web console at /console
   * @default false
   */
  enableConsole?: boolean;
}

type RouteHandler = (
  params: Record<string, string>,
  request: Request,
  api: HandlerAPI,
) => Promise<Response>;

// Helper function to get console static files path
function getConsoleDistPath(): string {
  // @hot-updater/console package dist directory
  // When imported, we need to resolve relative to console package
  try {
    // Try to resolve console package
    const consolePath = require.resolve("@hot-updater/console");
    // console path will be like: .../packages/console/dist/index.js
    // We want: .../packages/console/dist
    return join(consolePath, "..");
  } catch {
    // Fallback: assume monorepo structure
    const currentFile = fileURLToPath(import.meta.url);
    // Go up from server/dist to packages level
    return join(currentFile, "..", "..", "..", "console", "dist");
  }
}

// MIME type mapping
const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Helper to serve static files
async function serveStaticFile(filePath: string): Promise<Response> {
  try {
    const content = await readFile(filePath);
    const ext = filePath.substring(filePath.lastIndexOf("."));
    const contentType = mimeTypes[ext] || "application/octet-stream";

    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control":
          ext === ".html" ? "no-cache" : "public, max-age=31536000",
      },
    });
  } catch (_error) {
    return new Response(JSON.stringify({ error: "File not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// Route handlers
const handleUpdate: RouteHandler = async (_params, request, api) => {
  const body = (await request.json()) as
    | AppVersionGetBundlesArgs
    | FingerprintGetBundlesArgs;
  const updateInfo = await api.getAppUpdateInfo(body);

  return new Response(JSON.stringify(updateInfo), {
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

// Console RPC handlers
const handleConsoleGetConfig: RouteHandler = async () => {
  return new Response(JSON.stringify({ console: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleConsoleGetChannels: RouteHandler = async (
  _params,
  _request,
  api,
) => {
  const channels = await api.getChannels();
  return new Response(JSON.stringify(channels), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleConsoleGetConfigLoaded: RouteHandler = async () => {
  return new Response(JSON.stringify({ configLoaded: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleConsoleGetBundles: RouteHandler = async (_params, request, api) => {
  const url = new URL(request.url);
  const channel = url.searchParams.get("channel") ?? undefined;
  const platform = url.searchParams.get("platform") ?? undefined;
  const limit = Number(url.searchParams.get("limit")) || 20;
  const offset = Number(url.searchParams.get("offset")) || 0;

  const result = await api.getBundles({
    where: {
      ...(channel && { channel }),
      ...(platform && { platform }),
    },
    limit,
    offset,
  });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleConsoleGetBundle: RouteHandler = async (params, _request, api) => {
  const bundle = await api.getBundleById(params.bundleId);
  return new Response(JSON.stringify(bundle ?? null), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const handleConsoleUpdateBundle: RouteHandler = async (
  params,
  request,
  api,
) => {
  try {
    const bundleId = params.bundleId;
    const partialBundle = (await request.json()) as Partial<Bundle>;

    if (!bundleId) {
      return new Response(
        JSON.stringify({ error: "Target bundle ID is required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Use the existing updateBundleById from HandlerAPI
    // Note: Console's updateBundle doesn't exist in HandlerAPI,
    // but we need to add it or use insertBundle
    const current = await api.getBundleById(bundleId);
    if (!current) {
      return new Response(JSON.stringify({ error: "Bundle not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const merged = { ...current, ...partialBundle };
    await api.insertBundle(merged);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error during bundle update:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

const handleConsoleCreateBundle: RouteHandler = async (
  _params,
  request,
  api,
) => {
  try {
    const bundle = (await request.json()) as Bundle;
    await api.insertBundle(bundle);
    return new Response(
      JSON.stringify({ success: true, bundleId: bundle.id }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error during bundle creation:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

const handleConsoleDeleteBundle: RouteHandler = async (
  params,
  _request,
  api,
) => {
  try {
    const bundleId = params.bundleId;
    const bundle = await api.getBundleById(bundleId);

    if (!bundle) {
      return new Response(JSON.stringify({ error: "Bundle not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    await api.deleteBundleById(bundleId);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error during bundle deletion:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// Route handlers map
const routes: Record<string, RouteHandler> = {
  update: handleUpdate,
  fingerprintUpdate: handleFingerprintUpdate,
  appVersionUpdate: handleAppVersionUpdate,
  getBundle: handleGetBundle,
  getBundles: handleGetBundles,
  createBundles: handleCreateBundles,
  deleteBundle: handleDeleteBundle,
  getChannels: handleGetChannels,
  // Console RPC routes
  consoleGetConfig: handleConsoleGetConfig,
  consoleGetChannels: handleConsoleGetChannels,
  consoleGetConfigLoaded: handleConsoleGetConfigLoaded,
  consoleGetBundles: handleConsoleGetBundles,
  consoleGetBundle: handleConsoleGetBundle,
  consoleUpdateBundle: handleConsoleUpdateBundle,
  consoleCreateBundle: handleConsoleCreateBundle,
  consoleDeleteBundle: handleConsoleDeleteBundle,
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
  const enableConsole = options.enableConsole ?? false;

  // Create and configure router
  const router = createRouter();

  // Register routes
  addRoute(router, "POST", "/update", "update");
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
  addRoute(router, "GET", "/bundles/:id", "getBundle");
  addRoute(router, "GET", "/bundles", "getBundles");
  addRoute(router, "POST", "/bundles", "createBundles");
  addRoute(router, "DELETE", "/bundles/:id", "deleteBundle");
  addRoute(router, "GET", "/channels", "getChannels");

  // Register console routes if enabled
  if (enableConsole) {
    addRoute(router, "GET", "/console/rpc/config", "consoleGetConfig");
    addRoute(router, "GET", "/console/rpc/channels", "consoleGetChannels");
    addRoute(
      router,
      "GET",
      "/console/rpc/config-loaded",
      "consoleGetConfigLoaded",
    );
    addRoute(router, "GET", "/console/rpc/bundles", "consoleGetBundles");
    addRoute(
      router,
      "GET",
      "/console/rpc/bundles/:bundleId",
      "consoleGetBundle",
    );
    addRoute(
      router,
      "PATCH",
      "/console/rpc/bundles/:bundleId",
      "consoleUpdateBundle",
    );
    addRoute(router, "POST", "/console/rpc/bundles", "consoleCreateBundle");
    addRoute(
      router,
      "DELETE",
      "/console/rpc/bundles/:bundleId",
      "consoleDeleteBundle",
    );
  }

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // Handle console static files if enabled
      if (enableConsole && path.startsWith("/console")) {
        // Serve console RPC and static files
        const consolePath = path.slice("/console".length) || "/";

        // Check if it's an RPC request (already handled by router)
        if (consolePath.startsWith("/rpc/")) {
          // Let router handle RPC requests
          const match = findRoute(router, method, path);
          if (match) {
            const handler = routes[match.data as string];
            if (handler) {
              return await handler(match.params || {}, request, api);
            }
          }
        }

        // Serve static files
        const distPath = getConsoleDistPath();

        // Handle /console/assets/* requests
        if (consolePath.startsWith("/assets/")) {
          const filePath = join(distPath, consolePath);
          return await serveStaticFile(filePath);
        }

        // For all other /console/* requests, serve index.html (SPA fallback)
        const indexPath = join(distPath, "index.html");
        try {
          const content = await readFile(indexPath, "utf-8");
          // Replace asset paths to include /console prefix
          const modifiedContent = content
            .replace(/href="\/assets\//g, 'href="/console/assets/')
            .replace(/src="\/assets\//g, 'src="/console/assets/');

          return new Response(modifiedContent, {
            status: 200,
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "no-cache",
            },
          });
        } catch (_error) {
          return new Response(JSON.stringify({ error: "Console not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      // Remove base path from pathname for API routes
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
