import type { HotUpdaterAPI } from "./db";

export interface HandlerOptions {
  /**
   * Base path for all routes
   * @default "/api"
   */
  basePath?: string;
}

/**
 * Creates a Web Standard Request handler for Hot Updater API
 * This handler is framework-agnostic and works with any framework
 * that supports Web Standard Request/Response (Hono, Elysia, etc.)
 */
export function createHandler(
  api: HotUpdaterAPI,
  options: HandlerOptions = {},
): (request: Request) => Promise<Response> {
  const basePath = options.basePath ?? "/api";

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // Remove base path from pathname
      const routePath = path.startsWith(basePath)
        ? path.slice(basePath.length)
        : path;

      // POST /api/update - Client checks for updates
      if (routePath === "/update" && method === "POST") {
        const body = await request.json();
        const updateInfo = await api.getAppUpdateInfo(body);

        if (!updateInfo) {
          return new Response(JSON.stringify({ update: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(
          JSON.stringify({
            update: true,
            ...updateInfo,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // GET /api/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId
      const fingerprintMatch = routePath.match(
        /^\/fingerprint\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/,
      );
      if (fingerprintMatch && method === "GET") {
        const [, platform, fingerprintHash, channel, minBundleId, bundleId] =
          fingerprintMatch;

        const updateInfo = await api.getAppUpdateInfo({
          _updateStrategy: "fingerprint",
          platform: platform as "ios" | "android",
          fingerprintHash,
          channel,
          minBundleId,
          bundleId,
        });

        if (!updateInfo) {
          return new Response(JSON.stringify({ update: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(
          JSON.stringify({
            update: true,
            ...updateInfo,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // GET /api/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId
      const appVersionMatch = routePath.match(
        /^\/app-version\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/,
      );
      if (appVersionMatch && method === "GET") {
        const [, platform, appVersion, channel, minBundleId, bundleId] =
          appVersionMatch;

        const updateInfo = await api.getAppUpdateInfo({
          _updateStrategy: "appVersion",
          platform: platform as "ios" | "android",
          appVersion,
          channel,
          minBundleId,
          bundleId,
        });

        if (!updateInfo) {
          return new Response(JSON.stringify({ update: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(
          JSON.stringify({
            update: true,
            ...updateInfo,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // GET /api/bundles - List bundles
      if (routePath === "/bundles" && method === "GET") {
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

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // POST /api/bundles - Create new bundle
      if (routePath === "/bundles" && method === "POST") {
        const bundle = await request.json();
        await api.insertBundle(bundle);

        return new Response(JSON.stringify({ success: true, bundle }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      // DELETE /api/bundles/:id - Delete bundle
      if (routePath.startsWith("/bundles/") && method === "DELETE") {
        const id = routePath.slice("/bundles/".length);
        await api.deleteBundleById(id);

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // GET /api/channels - List all channels
      if (routePath === "/channels" && method === "GET") {
        const channels = await api.getChannels();

        return new Response(JSON.stringify({ channels }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // 404 Not Found
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
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
