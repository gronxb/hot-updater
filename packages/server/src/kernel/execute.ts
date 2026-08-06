import type { HotUpdaterContext } from "@hot-updater/plugin-core";

import { authenticateMatchedRoute } from "./authentication";
import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterRouteContext,
} from "./contracts";
import {
  matchCompiledRoute,
  type CompiledRouteMatch,
  type CompiledRouter,
} from "./routeCompiler";

export type ExecuteKernelRequestOptions<TContext> = {
  readonly authentication?: HotUpdaterAuthenticationProvider;
  readonly basePath: string;
  readonly platformContext?: HotUpdaterContext<TContext>;
  readonly request: Request;
  readonly router: CompiledRouter;
};

function opaqueResponse(status: 404 | 500): Response {
  return Response.json(
    { error: status === 404 ? "Not found" : "Internal server error" },
    {
      headers: { "cache-control": "private, no-store" },
      status,
    },
  );
}

function applyRouteCachePolicy(
  response: Response,
  matched: CompiledRouteMatch,
): Response {
  if (matched.route.access.kind !== "protected") return response;

  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export async function executeKernelRequest<TContext = unknown>(
  options: ExecuteKernelRequestOptions<TContext>,
): Promise<Response> {
  try {
    const url = new URL(options.request.url);
    const matched = matchCompiledRoute({
      basePath: options.basePath,
      method: options.request.method,
      pathname: url.pathname,
      router: options.router,
    });
    if (matched === undefined) return opaqueResponse(404);

    const authentication = await authenticateMatchedRoute({
      headers: options.request.headers,
      provider: options.authentication,
      route: matched.descriptor,
      signal: options.request.signal,
      url,
    });
    if (authentication.kind === "response") {
      return applyRouteCachePolicy(authentication.response, matched);
    }

    const context: HotUpdaterRouteContext<TContext> = Object.freeze({
      ...authentication.context,
      headers: new Headers(options.request.headers),
      platformContext: options.platformContext,
      signal: options.request.signal,
      url: new URL(url),
    });
    const routeInput =
      matched.route.input === undefined
        ? undefined
        : await matched.route.input.parse(options.request);
    const response = await matched.route.handle(context, routeInput);
    return applyRouteCachePolicy(response, matched);
  } catch {
    return opaqueResponse(500);
  }
}
