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
import { s3Storage } from "../src/s3Storage";
import { withCloudFrontSignedUrl } from "../src/withCloudFrontSignedUrl";

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
  config: {
    distributionDomainName: string;
  };
};

type SignedUrlContext = {
  request?: Request;
  distributionDomainName?: string;
};

const resolveRequestOrigin = (context?: SignedUrlContext) => {
  if (context?.distributionDomainName) {
    return `https://${context.distributionDomainName}`;
  }

  if (!context?.request) {
    throw new Error(
      "CloudFront signed URL resolution requires a request context.",
    );
  }

  return new URL(context.request.url).origin;
};

const hotUpdater = createHotUpdater<SignedUrlContext>({
  database: s3Database({
    bucketName: S3_BUCKET_NAME,
    region: SSM_REGION,
  }),
  storages: [
    withCloudFrontSignedUrl(
      s3Storage({
        bucketName: S3_BUCKET_NAME,
        region: SSM_REGION,
      }),
      {
        keyPairId: CLOUDFRONT_KEY_PAIR_ID,
        ssmRegion: SSM_REGION,
        ssmParameterName: SSM_PARAMETER_NAME,
        publicBaseUrl: resolveRequestOrigin,
      },
    ),
  ],
  basePath: HOT_UPDATER_BASE_PATH,
  routes: {
    updateCheck: true,
    bundles: false,
  },
});

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
  const rewrittenRequest = rewriteLegacyExactRequestToCanonical({
    basePath: hotUpdater.basePath,
    request: c.req.raw,
    headers: cloudFrontHeadersToHeaders(c.env.request.headers),
  });

  if (rewrittenRequest instanceof Response) {
    rewrittenRequest.headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
    return rewrittenRequest;
  }

  const response = await hotUpdater.handler(rewrittenRequest, {
    request: rewrittenRequest,
    distributionDomainName: c.env.config.distributionDomainName,
  });
  response.headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
  return response;
});

app.on(
  HOT_UPDATER_METHODS,
  wildcardPattern(HOT_UPDATER_BASE_PATH),
  async (c) => {
    const response = await hotUpdater.handler(c.req.raw, {
      request: c.req.raw,
      distributionDomainName: c.env.config.distributionDomainName,
    });

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
