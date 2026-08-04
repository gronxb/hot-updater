import type { HotUpdaterContext } from "@hot-updater/plugin-core";

import {
  type CoreRouteHandlerKey,
  getCoreRouteDescriptors,
} from "./coreRouteDescriptors";
import { createBundleRouteHandlers } from "./handlerBundleRoutes";
import { HandlerBadRequestError } from "./handlerErrors";
import type { HandlerAPI, HandlerOptions, RouteHandler } from "./handlerTypes";
import { createUpdateRouteHandlers } from "./handlerUpdateRoutes";
import { addRoute, createRouter, findRoute } from "./internalRouter";

export type { HandlerAPI, HandlerOptions, HandlerRoutes } from "./handlerTypes";

type Handler<TContext> = (
  request: Request,
  context?: HotUpdaterContext<TContext>,
) => Promise<Response>;

function opaqueHandlerErrorResponse(): Response {
  return Response.json(
    { error: "Internal server error" },
    {
      headers: { "Cache-Control": "private, no-store" },
      status: 500,
    },
  );
}

export function createHandler<TContext = unknown>(
  api: HandlerAPI<TContext>,
  options: HandlerOptions = {},
): Handler<TContext> {
  return createHandlerWithErrorPolicy(api, options, "legacy");
}

export function createRuntimeHandler<TContext = unknown>(
  api: HandlerAPI<TContext>,
  options: HandlerOptions = {},
): Handler<TContext> {
  return createHandlerWithErrorPolicy(api, options, "opaque");
}

function createHandlerWithErrorPolicy<TContext>(
  api: HandlerAPI<TContext>,
  options: HandlerOptions,
  errorPolicy: "legacy" | "opaque",
): Handler<TContext> {
  const basePath = options.basePath ?? "/api";
  const router = createRouter<CoreRouteHandlerKey>();
  const routeHandlers: Record<CoreRouteHandlerKey, RouteHandler<TContext>> = {
    ...createUpdateRouteHandlers<TContext>(),
    ...createBundleRouteHandlers<TContext>(),
  };

  for (const route of getCoreRouteDescriptors(options.routes)) {
    addRoute(router, route.method, route.path, route.handlerKey);
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
        if (errorPolicy === "opaque") return opaqueHandlerErrorResponse();
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
      if (errorPolicy === "opaque") {
        console.error("Hot Updater handler error");
        return opaqueHandlerErrorResponse();
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
