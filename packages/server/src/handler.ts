import type { HotUpdaterContext } from "@hot-updater/plugin-core";

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

export function createHandler<TContext = unknown>(
  api: HandlerAPI<TContext>,
  options: HandlerOptions = {},
): (
  request: Request,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response> {
  const basePath = options.basePath ?? "/api";
  const routeOptions = {
    updateCheck: options.routes?.updateCheck ?? true,
    bundles: options.routes?.bundles ?? false,
  } satisfies HandlerRoutes;
  const router = createRouter<string>();
  const routeHandlers: Record<string, RouteHandler<TContext>> = {
    ...createUpdateRouteHandlers<TContext>(),
    ...createBundleRouteHandlers<TContext>(),
  };

  addRoute(router, "GET", "/version", "version");
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

  return async (request, context): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname;
      const routePath = path.startsWith(basePath)
        ? path.slice(basePath.length)
        : path;
      const match = findRoute(router, request.method, routePath);
      if (!match) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      const handler = routeHandlers[match.data];
      if (!handler) {
        return new Response(JSON.stringify({ error: "Handler not found" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return await handler(match.params, request, api, context);
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
