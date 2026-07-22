import type { HotUpdaterContext } from "@hot-updater/plugin-core";

import { BundleEventScanLimitExceededError } from "./db/bundleEventScan";
import { supportsAnalytics } from "./db/types";
import { createAnalyticsRouteHandlers } from "./handlerAnalyticsRoutes";
import { createBundleRouteHandlers } from "./handlerBundleRoutes";
import {
  HandlerBadRequestError,
  HandlerPayloadTooLargeError,
} from "./handlerErrors";
import { createEventIngestionRouteHandlers } from "./handlerEventIngestionRoutes";
import type {
  HandlerAPI,
  HandlerOptions,
  HandlerRoutes,
  RouteHandler,
} from "./handlerTypes";
import { createUpdateRouteHandlers } from "./handlerUpdateRoutes";
import { addRoute, createRouter, findRoute } from "./internalRouter";

export type {
  AuthorizeEventIngestion,
  HandlerAPI,
  HandlerEventIngestionOptions,
  HandlerOptions,
  HandlerRoutes,
} from "./handlerTypes";

export function createHandler<TContext = unknown>(
  api: HandlerAPI<TContext>,
  options: HandlerOptions<TContext> = {},
): (
  request: Request,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response> {
  const basePath = options.basePath ?? "/api";
  const routeOptions = {
    updateCheck: options.routes?.updateCheck ?? true,
    bundles: options.routes?.bundles ?? false,
    analytics: options.routes?.analytics ?? false,
  } satisfies HandlerRoutes;
  const analyticsSupported = supportsAnalytics(api);
  const router = createRouter<string>();
  const routeHandlers: Record<string, RouteHandler<TContext>> = {
    ...createUpdateRouteHandlers<TContext>(),
    ...createBundleRouteHandlers<TContext>(),
    ...(options.eventIngestion
      ? createEventIngestionRouteHandlers(options.eventIngestion)
      : {}),
    ...createAnalyticsRouteHandlers<TContext>(),
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

  if (analyticsSupported && options.eventIngestion) {
    addRoute(router, "POST", "/events", "appendBundleEvent");
  }

  if (routeOptions.analytics && analyticsSupported) {
    addRoute(
      router,
      "GET",
      "/api/bundles/:id/events/summary",
      "getBundleEventSummary",
    );
    addRoute(
      router,
      "GET",
      "/api/bundles/:id/events/analytics",
      "getBundleEventAnalytics",
    );
    addRoute(router, "GET", "/api/installations", "searchInstallations");
    addRoute(
      router,
      "GET",
      "/api/installations/overview",
      "getBundleEventOverview",
    );
    addRoute(
      router,
      "GET",
      "/api/installations/active",
      "getActiveInstallationOverview",
    );
    addRoute(
      router,
      "GET",
      "/api/installations/:installId/events",
      "getInstallationHistory",
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
      if (error instanceof HandlerPayloadTooLargeError) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (error instanceof BundleEventScanLimitExceededError) {
        return new Response(
          JSON.stringify({
            error: {
              code: "ANALYTICS_SCAN_LIMIT_EXCEEDED",
              limit: error.limit,
            },
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      console.error("Hot Updater handler error:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
}
