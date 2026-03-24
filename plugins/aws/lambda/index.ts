import {
  createHotUpdater,
  isCanonicalUpdateRoute,
  rewriteLegacyExactRequestToCanonical,
  wildcardPattern,
} from "@hot-updater/server/runtime";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { Hono } from "hono";
import type { Callback, CloudFrontRequest } from "hono/lambda-edge";
import { handle } from "hono/lambda-edge";
import { s3Database } from "../src/s3Database";
import { s3LambdaEdgeStorage } from "../src/s3LambdaEdgeStorage";

declare global {
  var HotUpdater: {
    CLOUDFRONT_KEY_PAIR_ID: string;
    SSM_PARAMETER_NAME: string;
    SSM_REGION: string;
    S3_BUCKET_NAME: string;
  };
}

export const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;
export const NO_STORE_CACHE_CONTROL = "no-store";
export const SHARED_EDGE_CACHE_CONTROL = `public, max-age=0, s-maxage=${ONE_YEAR_IN_SECONDS}, must-revalidate`;
export const HOT_UPDATER_METHODS = ["GET", "POST", "PATCH", "DELETE"];
export const HOT_UPDATER_BASE_PATH = "/api/check-update";

const CLOUDFRONT_KEY_PAIR_ID = HotUpdater.CLOUDFRONT_KEY_PAIR_ID;
const SSM_PARAMETER_NAME = HotUpdater.SSM_PARAMETER_NAME;
const SSM_REGION = HotUpdater.SSM_REGION;
const S3_BUCKET_NAME = HotUpdater.S3_BUCKET_NAME;

type Bindings = {
  callback: Callback;
  request: CloudFrontRequest;
};

const hotUpdaterCache = new Map<string, ReturnType<typeof createHotUpdater>>();

const getHotUpdater = (requestUrl: string) => {
  const publicBaseUrl = new URL(requestUrl).origin;
  const cached = hotUpdaterCache.get(publicBaseUrl);

  if (cached) {
    return cached;
  }

  const hotUpdater = createHotUpdater({
    database: s3Database({
      bucketName: S3_BUCKET_NAME,
      region: SSM_REGION,
    }),
    storages: [
      s3LambdaEdgeStorage({
        bucketName: S3_BUCKET_NAME,
        region: SSM_REGION,
        keyPairId: CLOUDFRONT_KEY_PAIR_ID,
        ssmRegion: SSM_REGION,
        ssmParameterName: SSM_PARAMETER_NAME,
        publicBaseUrl,
      }),
    ],
    basePath: HOT_UPDATER_BASE_PATH,
    routes: {
      updateCheck: true,
      bundles: false,
    },
  });

  hotUpdaterCache.set(publicBaseUrl, hotUpdater);
  return hotUpdater;
};

const cloudFrontHeadersToHeaders = (
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

const app = new Hono<{ Bindings: Bindings }>();

app.get(HOT_UPDATER_BASE_PATH, async (c) => {
  const hotUpdater = getHotUpdater(c.req.url);
  const rewrittenRequest = rewriteLegacyExactRequestToCanonical({
    basePath: hotUpdater.basePath,
    request: c.req.raw,
    headers: cloudFrontHeadersToHeaders(c.env.request.headers),
  });

  if (rewrittenRequest instanceof Response) {
    rewrittenRequest.headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
    return rewrittenRequest;
  }

  const response = await hotUpdater.handler(rewrittenRequest);
  response.headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
  return response;
});

app.on(
  HOT_UPDATER_METHODS,
  wildcardPattern(HOT_UPDATER_BASE_PATH),
  async (c) => {
    const hotUpdater = getHotUpdater(c.req.url);
    const response = await hotUpdater.handler(c.req.raw);

    if (
      c.req.method === "GET" &&
      isCanonicalUpdateRoute(hotUpdater.basePath, new URL(c.req.url).pathname)
    ) {
      response.headers.set("Cache-Control", SHARED_EDGE_CACHE_CONTROL);
    }

    return response;
  },
);

export const handler = handle(app) as CloudFrontRequestHandler;
