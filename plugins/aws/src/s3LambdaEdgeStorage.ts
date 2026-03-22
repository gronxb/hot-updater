import { SSM } from "@aws-sdk/client-ssm";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import type {
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";
import type { S3StorageConfig } from "./s3Storage";
import { s3Storage } from "./s3Storage";

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

interface AwsLambdaEdgeStoragePrivateKeyFromGetter {
  getPrivateKey: () => Promise<string>;
  ssmParameterName?: never;
  ssmRegion?: never;
}

interface AwsLambdaEdgeStoragePrivateKeyFromSsm {
  getPrivateKey?: never;
  ssmParameterName: string;
  ssmRegion: string;
}

export type AwsLambdaEdgeStorageConfig = S3StorageConfig &
  (
    | AwsLambdaEdgeStoragePrivateKeyFromGetter
    | AwsLambdaEdgeStoragePrivateKeyFromSsm
  ) & {
    keyPairId: string;
    publicBaseUrl: string;
    expiresSeconds?: number;
  };

const privateKeyCache = new Map<string, Promise<string>>();

const getPrivateKeyFromSsm = async (
  region: string,
  parameterName: string,
): Promise<string> => {
  if (!region) {
    throw new Error(
      `Invalid AWS region format: ${region}. Expected format like 'us-east-1' or 'ap-southeast-1'`,
    );
  }

  const ssmClient = new SSM({ region });
  const response = await ssmClient.getParameter({
    Name: parameterName,
    WithDecryption: true,
  });

  if (!response.Parameter?.Value) {
    throw new Error(
      `Failed to retrieve private key from SSM parameter: ${parameterName}`,
    );
  }

  let keyPair: { privateKey?: unknown };
  try {
    keyPair = JSON.parse(response.Parameter.Value);
  } catch (error) {
    throw new Error(
      `Invalid JSON format in SSM parameter: ${parameterName}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const privateKey = keyPair.privateKey;
  if (!privateKey || typeof privateKey !== "string") {
    throw new Error(
      `Invalid private key format in SSM parameter: ${parameterName}`,
    );
  }

  return privateKey;
};

const resolvePrivateKey = (config: AwsLambdaEdgeStorageConfig) => {
  if ("getPrivateKey" in config && typeof config.getPrivateKey === "function") {
    return config.getPrivateKey();
  }

  const cacheKey = `${config.ssmRegion}:${config.ssmParameterName}`;
  const cachedPrivateKey = privateKeyCache.get(cacheKey);
  if (cachedPrivateKey) {
    return cachedPrivateKey;
  }

  const privateKeyPromise = getPrivateKeyFromSsm(
    config.ssmRegion,
    config.ssmParameterName,
  ).catch((error) => {
    privateKeyCache.delete(cacheKey);
    throw error;
  });

  privateKeyCache.set(cacheKey, privateKeyPromise);
  return privateKeyPromise;
};

export const awsLambdaEdgeStorage = (
  config: AwsLambdaEdgeStorageConfig,
  hooks?: StoragePluginHooks,
) => {
  const baseStorageFactory = s3Storage(config, hooks);

  return (): StoragePlugin => {
    const baseStorage = baseStorageFactory();

    return {
      ...baseStorage,
      name: "awsLambdaEdgeStorage",
      async getDownloadUrl(storageUri) {
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "s3:") {
          return baseStorage.getDownloadUrl(storageUri);
        }

        const privateKey = await resolvePrivateKey(config);
        const url = new URL(config.publicBaseUrl);
        url.pathname = storageUrl.pathname;
        url.search = "";

        return {
          fileUrl: getSignedUrl({
            url: url.toString(),
            keyPairId: config.keyPairId,
            privateKey,
            dateLessThan: new Date(
              Date.now() +
                (config.expiresSeconds ?? ONE_YEAR_IN_SECONDS) * 1000,
            ).toISOString(),
          }),
        };
      },
    };
  };
};

export const s3LambdaEdgeStorage = awsLambdaEdgeStorage;
