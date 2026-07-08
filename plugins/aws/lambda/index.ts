import { createHotUpdater } from "@hot-updater/server";
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

type HotUpdaterApi = ReturnType<typeof createHotUpdater>;

const hotUpdaterByPublicBaseUrl = new Map<string, HotUpdaterApi>();

const getHotUpdater = (publicBaseUrl: string): HotUpdaterApi => {
  const cachedHotUpdater = hotUpdaterByPublicBaseUrl.get(publicBaseUrl);
  if (cachedHotUpdater) {
    return cachedHotUpdater;
  }

  const hotUpdater = createHotUpdater({
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
          publicBaseUrl,
        },
      ),
    ],
    basePath: HOT_UPDATER_BASE_PATH,
    routes: {
      updateCheck: true,
      bundles: false,
    },
  });

  hotUpdaterByPublicBaseUrl.set(publicBaseUrl, hotUpdater);
  return hotUpdater;
};

const app = new Hono<{ Bindings: Bindings }>();

app.mount(
  HOT_UPDATER_BASE_PATH,
  async (request: Request, distributionDomainName: string) => {
    const hotUpdater = getHotUpdater(`https://${distributionDomainName}`);
    const response = await hotUpdater.handler(request);

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
