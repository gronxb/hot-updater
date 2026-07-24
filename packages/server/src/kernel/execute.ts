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
  try {
    const url = new URL(options.request.url);
    const matched = matchCompiledRoute({
      basePath: options.basePath,
      method: options.request.method,
      pathname: url.pathname,
      router: options.router,
    });
    if (matched === undefined) return opaqueResponse(404);

    const maximumBodyBytes = matched.route.requestPolicy?.maximumBodyBytes;
    if (maximumBodyBytes !== undefined) {
      const rejected = checkDeclaredBodyLength(
        options.request.headers,
        maximumBodyBytes,
        matched.route.requestPolicy?.payloadTooLargeResponse,
      );
      if (rejected !== undefined) return rejected;
    }

    const authentication = await authenticate(options, matched, url);
    if (authentication.kind === "response") {
      return authentication.response;
    }

    const boundedRequest =
      maximumBodyBytes !== undefined &&
      isBodyCapableMethod(matched.route.method)
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
          matched.route.input === undefined
            ? undefined
            : await matched.route.input.parse(boundedRequest);
        return matched.route.handle(context, input);
      } catch (error) {
        if (error instanceof HotUpdaterPayloadTooLargeError) {
          return payloadTooLargeResponse(
            matched.route.requestPolicy?.payloadTooLargeResponse,
          );
        }
        throw error;
      }
    };
    return executePostAuthMiddleware({
      context: authentication.context,
      handler: executeRoute,
      middleware: options.middleware,
    });
  } catch {
    return opaqueResponse(500);
  }
};
