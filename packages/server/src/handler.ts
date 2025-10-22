import type {
  AppUpdateInfo,
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
} from "@hot-updater/core";
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
}

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
        const body = (await request.json()) as
          | AppVersionGetBundlesArgs
          | FingerprintGetBundlesArgs;
        const updateInfo = await api.getAppUpdateInfo(body);

        if (!updateInfo) {
          return new Response(JSON.stringify(null), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify(updateInfo), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
          return new Response(JSON.stringify(null), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify(updateInfo), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
          return new Response(JSON.stringify(null), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify(updateInfo), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // GET /api/bundles/:id - Get single bundle
      const getBundleMatch = routePath.match(/^\/bundles\/([^/]+)$/);
      if (getBundleMatch && method === "GET") {
        const id = getBundleMatch[1];
        const bundle = await api.getBundleById(id);

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

        return new Response(JSON.stringify(result.data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // POST /api/bundles - Create new bundle(s)
      if (routePath === "/bundles" && method === "POST") {
        const body = await request.json();
        const bundles = Array.isArray(body) ? body : [body];

        for (const bundle of bundles) {
          await api.insertBundle(bundle as Bundle);
        }

        return new Response(JSON.stringify({ success: true }), {
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
