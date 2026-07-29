import type { HotUpdaterContext } from "@hot-updater/plugin-core";

import {
  authenticateMatchedRoute,
  type AuthenticationDecision,
} from "./authentication";
import type {
  HotUpdaterAuthenticationProvider,
  HotUpdaterPostAuthMiddleware,
  HotUpdaterRouteContext,
} from "./contracts";
import { executePostAuthMiddleware } from "./middlewareDag";
import {
  applyBoundedBody,
  checkDeclaredBodyLength,
  HotUpdaterPayloadTooLargeError,
} from "./requestBody";
import {
  isBodyCapableMethod,
  matchCompiledRoute,
  type CompiledRouter,
} from "./routeCompiler";
import { payloadTooLargeResponse } from "./staticResponse";

export type ExecuteKernelRequestOptions<TContext> = {
  readonly authentication?: HotUpdaterAuthenticationProvider;
  readonly basePath: string;
  readonly middleware: readonly HotUpdaterPostAuthMiddleware[];
  readonly platformContext?: HotUpdaterContext<TContext>;
  readonly request: Request;
  readonly router: CompiledRouter;
};

const opaqueResponse = (status: 404 | 413 | 500): Response => {
  const error =
    status === 404
      ? "Not found"
      : status === 413
        ? "Payload too large"
        : "Internal server error";
  return Response.json({ error }, { status });
};

const preventCaching = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const applyMatchedRouteCachePolicy = (
  response: Response,
  matched: ReturnType<typeof matchCompiledRoute>,
): Response =>
  matched?.route.access.kind === "protected"
    ? preventCaching(response)
    : response;

const authenticate = <TContext>(
  options: ExecuteKernelRequestOptions<TContext>,
  route: ReturnType<typeof matchCompiledRoute>,
  url: URL,
): Promise<AuthenticationDecision> => {
  if (route === undefined) {
    return Promise.resolve({
      kind: "response",
      response: opaqueResponse(404),
    });
  }
  return authenticateMatchedRoute({
    headers: options.request.headers,
    provider: options.authentication,
    route: route.descriptor,
    signal: options.request.signal,
    url,
  });
};

export const executeKernelRequest = async <TContext = unknown>(
  options: ExecuteKernelRequestOptions<TContext>,
): Promise<Response> => {
  let matched: ReturnType<typeof matchCompiledRoute> = undefined;
  try {
    const url = new URL(options.request.url);
    matched = matchCompiledRoute({
      basePath: options.basePath,
      method: options.request.method,
      pathname: url.pathname,
      router: options.router,
    });
    if (matched === undefined) return opaqueResponse(404);
    const matchedRoute = matched;

    const maximumBodyBytes = matchedRoute.route.requestPolicy?.maximumBodyBytes;
    if (maximumBodyBytes !== undefined) {
      const rejected = checkDeclaredBodyLength(
        options.request.headers,
        maximumBodyBytes,
        matchedRoute.route.requestPolicy?.payloadTooLargeResponse,
      );
      if (rejected !== undefined) {
        return applyMatchedRouteCachePolicy(rejected, matchedRoute);
      }
    }

    const authentication = await authenticate(options, matchedRoute, url);
    if (authentication.kind === "response") {
      return applyMatchedRouteCachePolicy(
        authentication.response,
        matchedRoute,
      );
    }

    const boundedRequest =
      maximumBodyBytes !== undefined &&
      isBodyCapableMethod(matchedRoute.route.method)
        ? applyBoundedBody(options.request, maximumBodyBytes)
        : options.request;
    const context: HotUpdaterRouteContext<TContext> = Object.freeze({
      ...authentication.context,
      headers: new Headers(boundedRequest.headers),
      platformContext: options.platformContext,
      signal: boundedRequest.signal,
      url: new URL(boundedRequest.url),
    });
    const executeRoute = async (): Promise<Response> => {
      try {
        const input =
          matchedRoute.route.input === undefined
            ? undefined
            : await matchedRoute.route.input.parse(boundedRequest);
        return matchedRoute.route.handle(context, input);
      } catch (error) {
        if (error instanceof HotUpdaterPayloadTooLargeError) {
          return payloadTooLargeResponse(
            matchedRoute.route.requestPolicy?.payloadTooLargeResponse,
          );
        }
        throw error;
      }
    };
    const response = await executePostAuthMiddleware({
      context: authentication.context,
      handler: executeRoute,
      middleware: options.middleware,
    });
    return applyMatchedRouteCachePolicy(response, matchedRoute);
  } catch {
    return applyMatchedRouteCachePolicy(opaqueResponse(500), matched);
  }
};
