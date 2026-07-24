import { apiKey } from "@hot-updater/api-key";
import { createHotUpdater } from "@hot-updater/server";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { Hono } from "hono";
import type { Callback, CloudFrontRequest } from "hono/lambda-edge";
import { handle } from "hono/lambda-edge";

import { s3Database, s3Storage } from "../src/lambda";

declare global {
  var HotUpdater: {
    API_KEY_SHA256: string;
    CLOUDFRONT_KEY_PAIR_ID: string;
    SSM_PARAMETER_NAME: string;
    SSM_REGION: string;
    S3_BUCKET_NAME: string;
  };
}

export const PRIVATE_EDGE_CACHE_CONTROL = "private, no-store";
export const HOT_UPDATER_BASE_PATH = "/api/check-update";

const API_KEY_SHA256 = HotUpdater.API_KEY_SHA256;
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

const plugins = [apiKey({ sha256: API_KEY_SHA256 })] as const;

const hotUpdater = createHotUpdater<SignedUrlContext, typeof plugins>({
  database: s3Database({
    bucketName: S3_BUCKET_NAME,
    region: SSM_REGION,
  }),
  storages: [
    s3Storage({
      bucketName: S3_BUCKET_NAME,
      region: SSM_REGION,
      keyPairId: CLOUDFRONT_KEY_PAIR_ID,
      ssmRegion: SSM_REGION,
      ssmParameterName: SSM_PARAMETER_NAME,
      publicBaseUrl: resolveRequestOrigin,
    })(),
  ],
  basePath: "/",
  plugins,
  routes: {
    bundles: false,
    updateCheck: true,
  },
});

const app = new Hono<{ Bindings: Bindings }>();

app.mount(
  HOT_UPDATER_BASE_PATH,
  async (request: Request, distributionDomainName: string) => {
    const response = await hotUpdater.handler(request, {
      request,
      distributionDomainName,
    });

    response.headers.set("Cache-Control", PRIVATE_EDGE_CACHE_CONTROL);

    return response;
  },
  {
    optionHandler: (c) => [c.env.config.distributionDomainName],
  },
);

export const handler = handle(app) as CloudFrontRequestHandler;
