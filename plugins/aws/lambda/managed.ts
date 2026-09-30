import { AsyncLocalStorage } from "node:async_hooks";

import type { HotUpdaterHandlers } from "@hot-updater/server";
import type { CloudFrontRequestHandler } from "aws-lambda";
import { Hono } from "hono";
import type { Callback, CloudFrontRequest } from "hono/lambda-edge";
import { handle } from "hono/lambda-edge";

import { cloudFrontDownloadUrl } from "../src/cloudFrontDownloadUrl";
import { dynamoDB as tableDatabase } from "../src/dynamoDB";
import { s3Storage as bucketStorage } from "../src/s3Storage";

export { cloudFrontDownloadUrl } from "../src/cloudFrontDownloadUrl";
export { migrateDynamoDB } from "../src/dynamoDB";
export { plugins } from "../src/plugins";

declare global {
  var HotUpdater: {
    CLOUDFRONT_KEY_PAIR_ID: string;
    DYNAMODB_REGION: string;
    DYNAMODB_TABLE_NAME: string;
    SSM_PARAMETER_NAME: string;
    SSM_REGION: string;
    S3_BUCKET_NAME: string;
  };
}

/** The domain of the CloudFront distribution the current request came through. */
const distribution = new AsyncLocalStorage<string>();

/*
 * The managed Lambda@Edge function runs the project's server definition
 * with this module in place of `@hot-updater/aws`: the definition's database
 * and storage are the table and bucket init set up, reached with the
 * function's role, and download URLs are signed for the distribution each
 * request came through. The credentials the definition passes, which are
 * the CLI's, go unused.
 */

/** The server definition's database in the managed function: the table init set up. */
export const dynamoDB = (_config?: unknown) =>
  tableDatabase({
    region: HotUpdater.DYNAMODB_REGION,
    tableName: HotUpdater.DYNAMODB_TABLE_NAME,
  });

/**
 * The server definition's storage in the managed function: the bucket init
 * set up, whose downloads are CloudFront URLs signed with the key pair init
 * stored in SSM.
 */
export const s3Storage = (_config?: unknown) =>
  bucketStorage({
    bucketName: HotUpdater.S3_BUCKET_NAME,
    region: HotUpdater.SSM_REGION,
    getDownloadUrl: async (input) => {
      const domainName = distribution.getStore();
      if (domainName === undefined) {
        throw new Error(
          "The managed AWS server signs download URLs only while it serves a CloudFront request.",
        );
      }
      return cloudFrontDownloadUrl({
        keyPairId: HotUpdater.CLOUDFRONT_KEY_PAIR_ID,
        ssmRegion: HotUpdater.SSM_REGION,
        ssmParameterName: HotUpdater.SSM_PARAMETER_NAME,
        publicBaseUrl: `https://${domainName}`,
      })(input);
    },
  });

export const HOT_UPDATER_BASE_PATH = "/";

type Bindings = {
  callback: Callback;
  request: CloudFrontRequest;
  config: {
    distributionDomainName: string;
  };
};

/** The managed Lambda@Edge function: the server definition's client routes. */
export const serveManagedLambda = (hotUpdater: {
  readonly handlers: Pick<HotUpdaterHandlers, "client">;
}) => {
  const app = new Hono<{ Bindings: Bindings }>();
  app.mount(
    HOT_UPDATER_BASE_PATH,
    (request: Request, distributionDomainName: string) =>
      distribution.run(distributionDomainName, () =>
        hotUpdater.handlers.client(request),
      ),
    {
      optionHandler: (c) => [c.env.config.distributionDomainName],
    },
  );
  return handle(app) as CloudFrontRequestHandler;
};
