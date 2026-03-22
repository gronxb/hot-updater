import { createHotUpdater } from "@hot-updater/server";
import { createAwsLambdaEdgeHandler, HOT_UPDATER_BASE_PATH } from "./runtime";
import { s3Database } from "../src/s3Database";
import { s3LambdaEdgeStorage } from "../src/awsLambdaEdgeStorage";

declare global {
  var HotUpdater: {
    CLOUDFRONT_KEY_PAIR_ID: string;
    SSM_PARAMETER_NAME: string;
    SSM_REGION: string;
    S3_BUCKET_NAME: string;
  };
}

const CLOUDFRONT_KEY_PAIR_ID = HotUpdater.CLOUDFRONT_KEY_PAIR_ID;
const SSM_PARAMETER_NAME = HotUpdater.SSM_PARAMETER_NAME;
const SSM_REGION = HotUpdater.SSM_REGION;
const S3_BUCKET_NAME = HotUpdater.S3_BUCKET_NAME;

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

export const handler = createAwsLambdaEdgeHandler({
  getHotUpdater,
});
