import {
  type createHotUpdater,
  isCanonicalUpdateRoute,
  rewriteLegacyExactRequestToCanonical,
  wildcardPattern,
} from "@hot-updater/server";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { Hono } from "hono";
import type { Callback, CloudFrontRequest } from "hono/lambda-edge";
import { handle } from "hono/lambda-edge";
import {
  NO_STORE_CACHE_CONTROL,
  SHARED_EDGE_CACHE_CONTROL,
} from "./cacheControl";

type HotUpdaterRuntime = Pick<
  ReturnType<typeof createHotUpdater>,
  "basePath" | "handler"
>;

type Bindings = {
  callback: Callback;
  request: CloudFrontRequest;
};

export const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"];
export const HOT_UPDATER_BASE_PATH = "/api/check-update";

export interface CreateAwsLambdaEdgeAppOptions {
  basePath?: string;
  getHotUpdater: (requestUrl: string) => HotUpdaterRuntime;
  getLegacyHeaders?: (request: CloudFrontRequest) => Headers;
}

export const cloudFrontHeadersToHeaders = (
  headers: CloudFrontRequest["headers"],
): Headers => {
  const normalizedHeaders = new Headers();

  for (const [key, values] of Object.entries(headers)) {
    for (const value of values) {
      normalizedHeaders.append(key, value.value);
    }
  }

  return normalizedHeaders;
};

export const createAwsLambdaEdgeApp = ({
  basePath = HOT_UPDATER_BASE_PATH,
  getHotUpdater,
  getLegacyHeaders = (request) => cloudFrontHeadersToHeaders(request.headers),
}: CreateAwsLambdaEdgeAppOptions) => {
  const app = new Hono<{ Bindings: Bindings }>();

  app.get(basePath, async (c) => {
    const hotUpdater = getHotUpdater(c.req.url);
    const rewrittenRequest = rewriteLegacyExactRequestToCanonical({
      basePath: hotUpdater.basePath,
      request: c.req.raw,
      headers: getLegacyHeaders(c.env.request),
    });

    if (rewrittenRequest instanceof Response) {
      rewrittenRequest.headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
      return rewrittenRequest;
    }

    const response = await hotUpdater.handler(rewrittenRequest);
    response.headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
    return response;
  });

  app.on(HOT_UPDATER_METHODS, wildcardPattern(basePath), async (c) => {
    const hotUpdater = getHotUpdater(c.req.url);
    const response = await hotUpdater.handler(c.req.raw);

    if (
      c.req.method === "GET" &&
      isCanonicalUpdateRoute(hotUpdater.basePath, new URL(c.req.url).pathname)
    ) {
      response.headers.set("Cache-Control", SHARED_EDGE_CACHE_CONTROL);
    }

    return response;
  });

  return app;
};

export const createAwsLambdaEdgeHandler = (
  options: CreateAwsLambdaEdgeAppOptions,
) => {
  return handle(createAwsLambdaEdgeApp(options)) as CloudFrontRequestHandler;
};
