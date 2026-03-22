import { SSM } from "@aws-sdk/client-ssm";
import { createHotUpdater } from "@hot-updater/server";
import { awsLambdaEdgeDatabase, awsLambdaEdgeStorage } from "../src";
import { createAwsLambdaEdgeHandler, HOT_UPDATER_BASE_PATH } from "./runtime";

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

let cachedPrivateKey: string | null = null;

async function getPrivateKey(): Promise<string> {
  if (cachedPrivateKey !== null) {
    return cachedPrivateKey;
  }

  if (!SSM_REGION) {
    throw new Error(
      `Invalid AWS region format: ${SSM_REGION}. Expected format like 'us-east-1' or 'ap-southeast-1'`,
    );
  }

  const ssmClient = new SSM({ region: SSM_REGION });
  const response = await ssmClient.getParameter({
    Name: SSM_PARAMETER_NAME,
    WithDecryption: true,
  });

  if (!response.Parameter?.Value) {
    throw new Error(
      `Failed to retrieve private key from SSM parameter: ${SSM_PARAMETER_NAME}`,
    );
  }

  let keyPair: { privateKey?: unknown };
  try {
    keyPair = JSON.parse(response.Parameter.Value);
  } catch (error) {
    throw new Error(
      `Invalid JSON format in SSM parameter: ${SSM_PARAMETER_NAME}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const privateKey = keyPair.privateKey;
  if (!privateKey || typeof privateKey !== "string") {
    throw new Error(
      `Invalid private key format in SSM parameter: ${SSM_PARAMETER_NAME}`,
    );
  }

  cachedPrivateKey = privateKey;
  return privateKey;
}

const hotUpdaterCache = new Map<string, ReturnType<typeof createHotUpdater>>();

const getHotUpdater = (requestUrl: string) => {
  const publicBaseUrl = new URL(requestUrl).origin;
  const cached = hotUpdaterCache.get(publicBaseUrl);

  if (cached) {
    return cached;
  }

  const hotUpdater = createHotUpdater({
    database: awsLambdaEdgeDatabase({
      bucketName: S3_BUCKET_NAME,
      region: SSM_REGION,
    }),
    storages: [
      awsLambdaEdgeStorage({
        bucketName: S3_BUCKET_NAME,
        region: SSM_REGION,
        keyPairId: CLOUDFRONT_KEY_PAIR_ID,
        getPrivateKey,
        publicBaseUrl,
      }),
    ],
    basePath: HOT_UPDATER_BASE_PATH,
    features: {
      updateCheckOnly: true,
    },
  });

  hotUpdaterCache.set(publicBaseUrl, hotUpdater);
  return hotUpdater;
};

export const handler = createAwsLambdaEdgeHandler({
  getHotUpdater,
});
