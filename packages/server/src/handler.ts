import {
  type AnalyticsHandlerOptions,
  createAnalyticsRouteHandlers,
  registerAnalyticsRoutes,
} from "./analytics/routes";
import { createBundleRouteHandlers } from "./handlerBundleRoutes";
import { HandlerBadRequestError } from "./handlerErrors";
import { createReleaseCatalogRouteHandlers } from "./handlerReleaseCatalogRoutes";
import { createReleaseManagementRouteHandlers } from "./handlerReleaseManagementRoutes";
import type {
  HandlerAPI,
  HandlerFeatures,
  HandlerOptions,
  RouteHandler,
} from "./handlerTypes";
import { createVersionRouteHandlers } from "./handlerVersionRoutes";
import { addRoute, createRouter, findRoute } from "./internalRouter";

export type {
  HandlerAPI,
  HandlerFeatures,
  HandlerOptions,
} from "./handlerTypes";

export function createHandler(
  api: HandlerAPI,
  options: HandlerOptions = {},
): (request: Request) => Promise<Response> {
  return createHotUpdaterHandler(api, options);
}

export function createHotUpdaterHandler(
  api: HandlerAPI,
  options: HandlerOptions = {},
  analytics?: AnalyticsHandlerOptions,
  clientAccessKeys?: {
    readonly authenticate: (request: Request) => Promise<boolean>;
  },
  downloadStorageObject?: (
    token: string,
    signature: string,
  ) => Promise<Response | null>,
): (request: Request) => Promise<Response> {
  const basePath = options.basePath ?? "/api";
  const authorityId = options.authorityId ?? "default";
  const features = {
    updateCheck: options.features?.updateCheck ?? true,
    bundles: options.features?.bundles ?? false,
  } satisfies HandlerFeatures;
  const router = createRouter<string>();
  const routeHandlers: Record<string, RouteHandler> = {
    ...createVersionRouteHandlers(),
    ...createReleaseCatalogRouteHandlers(authorityId),
    ...createReleaseManagementRouteHandlers(),
    ...createBundleRouteHandlers(),
    ...(analytics === undefined ? {} : createAnalyticsRouteHandlers(analytics)),
    ...(downloadStorageObject === undefined
      ? {}
      : {
          downloadStorageObject: async (params) => {
            const token = params.token;
            const signature = params.signature;
            if (!token || !signature) {
              return Response.json({ error: "Not found" }, { status: 404 });
            }
            const response = await downloadStorageObject(token, signature);
            if (!response) {
              return Response.json({ error: "Not found" }, { status: 404 });
            }
            const headers = new Headers(response.headers);
            if (!headers.has("cache-control")) {
              headers.set(
                "cache-control",
                "public, max-age=31536000, immutable",
              );
            }
            return new Response(response.body, {
              headers,
              status: response.status,
              statusText: response.statusText,
            });
          },
        }),
  };

  addRoute(router, "GET", "/version", "version");
  if (downloadStorageObject !== undefined) {
    addRoute(
      router,
      "GET",
      "/storage/:token/:signature",
      "downloadStorageObject",
    );
  }
  if (features.updateCheck) {
    addRoute(
      router,
      "GET",
      "/release-catalogs/app-version/:authorityId/:platform/:channelKey/:appVersion",
      "appVersionReleaseCatalog",
    );
    addRoute(
      router,
      "GET",
      "/release-catalogs/fingerprint/:authorityId/:platform/:channelKey/:fingerprintHash",
      "fingerprintReleaseCatalog",
    );
    addRoute(
      router,
      "GET",
      "/artifacts/:targetBundleId/from/:currentBundleId",
      "artifact",
    );
  }

  if (features.bundles) {
    addRoute(router, "GET", "/api/releases/:id", "getRelease");
    addRoute(router, "GET", "/api/releases", "getReleases");
    addRoute(router, "PATCH", "/api/releases/:id", "updateRelease");
    addRoute(router, "POST", "/api/releases/:id/preflight", "preflightRelease");
    addRoute(router, "DELETE", "/api/releases/:id", "deleteRelease");
    addRoute(
      router,
      "GET",
      "/api/release-catalogs/:scopeKey",
      "getReleaseCatalogRow",
    );
    addRoute(router, "GET", "/api/release-catalogs", "getReleaseCatalogs");
    addRoute(
      router,
      "POST",
      "/api/release-catalogs/:scopeKey/rebuild",
      "rebuildReleaseCatalog",
    );
    addRoute(router, "POST", "/api/database/commit", "commitDatabase");
    addRoute(router, "GET", "/api/channels", "getChannels");
    addRoute(router, "POST", "/api/channels", "createChannel");
    addRoute(router, "DELETE", "/api/channels/:id", "deleteChannel");
    addRoute(router, "GET", "/api/bundles/:id", "getBundle");
    addRoute(router, "GET", "/api/bundles", "getBundles");
    addRoute(router, "POST", "/api/bundles", "createBundles");
    addRoute(router, "PATCH", "/api/bundles/:id", "updateBundle");
    addRoute(router, "DELETE", "/api/bundles/:id", "deleteBundle");
  }

  if (analytics !== undefined) {
    registerAnalyticsRoutes((method, path, handler) =>
      addRoute(router, method, path, handler),
    );
  }

  return async (request): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname;
      const routePath =
        basePath === "/"
          ? path
          : path === basePath
            ? "/"
            : path.startsWith(`${basePath}/`)
              ? path.slice(basePath.length)
              : null;
      const match =
        (routePath === null
          ? undefined
          : findRoute(router, request.method, routePath)) ??
        findRoute(router, request.method, path);
      if (!match) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: {
            "cache-control": "private, no-store",
            "Content-Type": "application/json",
          },
        });
      }
      if (
        clientAccessKeys !== undefined &&
        (match.data === "appVersionReleaseCatalog" ||
          match.data === "fingerprintReleaseCatalog" ||
          match.data === "artifact" ||
          match.data === "appendBundleEvent")
      ) {
        let authenticated: boolean;
        try {
          authenticated = await clientAccessKeys.authenticate(request);
        } catch {
          return Response.json(
            { error: "Service unavailable" },
            {
              status: 503,
              headers: { "cache-control": "private, no-store" },
            },
          );
        }
        if (!authenticated) {
          return Response.json(
            { error: "Unauthorized" },
            {
              status: 401,
              headers: { "cache-control": "private, no-store" },
            },
          );
        }
      }
      const handler = routeHandlers[match.data];
      if (!handler) {
        return new Response(JSON.stringify({ error: "Handler not found" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return await handler(match.params, request, api);
    } catch (error) {
      if (error instanceof HandlerBadRequestError) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 400,
          headers: {
            "cache-control": "private, no-store",
            "Content-Type": "application/json",
          },
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
          headers: {
            "cache-control": "private, no-store",
            "Content-Type": "application/json",
          },
        },
      );
    }
  };
}
