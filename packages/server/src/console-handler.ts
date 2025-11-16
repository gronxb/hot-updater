import type { Bundle } from "@hot-updater/core";
import { readFile } from "fs/promises";
import { join } from "path";
import { addRoute, createRouter, findRoute } from "rou3";
import { fileURLToPath } from "url";
import type { HandlerAPI } from "./handler";

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
 * Creates a Web Standard Request handler for Hot Updater Console
 * This handler serves the console UI and RPC endpoints without /console prefix
 * Mount this at /console in your application
 */
export function createConsoleHandler(
  api: HandlerAPI,
): (request: Request) => Promise<Response> {
  // Create and configure router
  const router = createRouter();

  // Register console RPC routes (without /console prefix)
  addRoute(router, "GET", "/rpc/config", "consoleGetConfig");
  addRoute(router, "GET", "/rpc/channels", "consoleGetChannels");
  addRoute(router, "GET", "/rpc/config-loaded", "consoleGetConfigLoaded");
  addRoute(router, "GET", "/rpc/bundles", "consoleGetBundles");
  addRoute(router, "GET", "/rpc/bundles/:bundleId", "consoleGetBundle");
  addRoute(router, "PATCH", "/rpc/bundles/:bundleId", "consoleUpdateBundle");
  addRoute(router, "POST", "/rpc/bundles", "consoleCreateBundle");
  addRoute(router, "DELETE", "/rpc/bundles/:bundleId", "consoleDeleteBundle");

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // Check if it's an RPC request
      if (path.startsWith("/rpc/")) {
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

      // Handle /assets/* requests
      if (path.startsWith("/assets/")) {
        const filePath = join(distPath, path);
        return await serveStaticFile(filePath);
      }

      // For all other requests, serve index.html (SPA fallback)
      try {
        const content = await readFile(join(distPath, "index.html"), "utf-8");
        // No need to replace paths since we're serving from root of console mount

        return new Response(content, {
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
    } catch (error) {
      console.error("Console handler error:", error);
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
