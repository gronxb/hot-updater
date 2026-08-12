import {
  type AnalyticsHandlerOptions,
  createAnalyticsRouteHandlers,
  registerAnalyticsRoutes,
} from "./analytics/routes";
import { createBundleRouteHandlers } from "./handlerBundleRoutes";
import { HandlerBadRequestError } from "./handlerErrors";
import type {
  HandlerAPI,
  HandlerOptions,
  HandlerRoutes,
  RouteHandler,
} from "./handlerTypes";
import { createUpdateRouteHandlers } from "./handlerUpdateRoutes";
import { addRoute, createRouter, findRoute } from "./internalRouter";

export type { HandlerAPI, HandlerOptions, HandlerRoutes } from "./handlerTypes";

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
  const routeOptions = {
    updateCheck: options.routes?.updateCheck ?? true,
    bundles: options.routes?.bundles ?? false,
  } satisfies HandlerRoutes;
  const router = createRouter<string>();
  const routeHandlers: Record<string, RouteHandler> = {
    ...createUpdateRouteHandlers(),
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
  if (routeOptions.updateCheck) {
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

  if (routeOptions.bundles) {
    addRoute(router, "GET", "/api/bundles/channels", "getChannels");
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
      const routePath = path.startsWith(basePath)
        ? path.slice(basePath.length)
        : path;
      const match =
        findRoute(router, request.method, routePath) ??
        (routePath === path
          ? undefined
          : findRoute(router, request.method, path));
      if (!match) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        clientAccessKeys !== undefined &&
        (match.data === "fingerprintUpdateWithCohort" ||
          match.data === "appVersionUpdateWithCohort" ||
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
