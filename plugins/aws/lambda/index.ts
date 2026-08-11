import { createManagedServerPlugins } from "@hot-updater/managed";
import { createHotUpdater } from "@hot-updater/server";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { Hono } from "hono";
import type { Callback, CloudFrontRequest } from "hono/lambda-edge";
import { handle } from "hono/lambda-edge";

import { dynamoDB } from "../src/dynamoDB";
import { s3Database } from "../src/s3Database";
import { s3Storage } from "../src/s3Storage";
import { withCloudFrontSignedUrl } from "../src/withCloudFrontSignedUrl";

declare global {
  var HotUpdater: {
    CLOUDFRONT_KEY_PAIR_ID: string;
    DATABASE_TYPE: string;
    DYNAMODB_REGION: string;
    DYNAMODB_TABLE_NAME: string;
    SSM_PARAMETER_NAME: string;
    SSM_REGION: string;
    S3_BUCKET_NAME: string;
  };
}

export const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;
export const SHARED_EDGE_CACHE_CONTROL = `public, max-age=0, s-maxage=${ONE_YEAR_IN_SECONDS}, must-revalidate`;
export const HOT_UPDATER_BASE_PATH = "/api/check-update";

const isCanonicalUpdateRoute = (path: string) => {
  return (
    path.startsWith("/app-version/") ||
    path.startsWith("/fingerprint/") ||
    path.startsWith(`${HOT_UPDATER_BASE_PATH}/app-version/`) ||
    path.startsWith(`${HOT_UPDATER_BASE_PATH}/fingerprint/`)
  );
};

const CLOUDFRONT_KEY_PAIR_ID = HotUpdater.CLOUDFRONT_KEY_PAIR_ID;
const DATABASE_TYPE = HotUpdater.DATABASE_TYPE;
const DYNAMODB_REGION = HotUpdater.DYNAMODB_REGION;
const DYNAMODB_TABLE_NAME = HotUpdater.DYNAMODB_TABLE_NAME;
const SSM_PARAMETER_NAME = HotUpdater.SSM_PARAMETER_NAME;
const SSM_REGION = HotUpdater.SSM_REGION;
const S3_BUCKET_NAME = HotUpdater.S3_BUCKET_NAME;

class AwsLambdaDatabaseTypeError extends Error {
  readonly name = "AwsLambdaDatabaseTypeError";

  constructor(readonly databaseType: string) {
    super(`Unsupported AWS metadata database "${databaseType}"`);
  }
}

const createManagedDatabase = () => {
  switch (DATABASE_TYPE) {
    case "dynamodb":
      return dynamoDB({
        region: DYNAMODB_REGION,
        tableName: DYNAMODB_TABLE_NAME,
      });
    case "s3":
      return s3Database({
        bucketName: S3_BUCKET_NAME,
        region: SSM_REGION,
      });
    default:
      throw new AwsLambdaDatabaseTypeError(DATABASE_TYPE);
  }
};

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

const database = createManagedDatabase();
const plugins =
  DATABASE_TYPE === "dynamodb" ? createManagedServerPlugins() : [];

const hotUpdater = createHotUpdater<SignedUrlContext>({
  database,
  plugins,
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

const app = new Hono<{ Bindings: Bindings }>();

app.mount(
  HOT_UPDATER_BASE_PATH,
  async (request: Request, distributionDomainName: string) => {
    const response = await hotUpdater.handler(request, {
      request,
      distributionDomainName,
    });

    if (
      request.method === "GET" &&
      isCanonicalUpdateRoute(new URL(request.url).pathname)
    ) {
      response.headers.set("Cache-Control", SHARED_EDGE_CACHE_CONTROL);
    }

    return response;
  },
  {
    optionHandler: (c) => [c.env.config.distributionDomainName],
  },
);

export const handler = handle(app) as CloudFrontRequestHandler;
