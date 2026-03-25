import { SSM } from "@aws-sdk/client-ssm";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import type {
  StoragePlugin,
  StorageResolveContext,
} from "@hot-updater/plugin-core";
import { applySsmRuntimeAwsConfig } from "./runtimeAwsConfig";

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

interface CloudFrontPrivateKeyFromGetter {
  getPrivateKey: () => Promise<string>;
  ssmParameterName?: never;
  ssmRegion?: never;
}

interface CloudFrontPrivateKeyFromSsm {
  getPrivateKey?: never;
  ssmParameterName: string;
  ssmRegion: string;
}

export type PublicBaseUrlResolver<TContext = unknown> = (
  context?: StorageResolveContext<TContext>,
) => string | Promise<string>;

export type CloudFrontSignedUrlConfig =
  | CloudFrontPrivateKeyFromGetter
  | CloudFrontPrivateKeyFromSsm;

export type WithCloudFrontSignedUrlOptions<TContext = unknown> =
  CloudFrontSignedUrlConfig & {
    keyPairId: string;
    publicBaseUrl: string | PublicBaseUrlResolver<TContext>;
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

  const ssmClient = new SSM(applySsmRuntimeAwsConfig({ region }));
  const response = await ssmClient.getParameter({
    Name: parameterName,
    WithDecryption: true,
  });

  const parameter = response.Parameter;
  if (!parameter) {
    throw new Error(
      `Failed to retrieve private key from SSM parameter: ${parameterName}`,
    );
  }

  const parameterValue = parameter.Value;
  if (!parameterValue) {
    throw new Error(
      `Failed to retrieve private key from SSM parameter: ${parameterName}`,
    );
  }

  let keyPair: { privateKey?: unknown };
  try {
    keyPair = JSON.parse(parameterValue);
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

const resolvePrivateKey = (
  config: CloudFrontSignedUrlConfig,
): Promise<string> => {
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

const resolvePublicBaseUrl = async <TContext>(
  config: WithCloudFrontSignedUrlOptions<TContext>,
  context?: StorageResolveContext<TContext>,
) => {
  const publicBaseUrl =
    typeof config.publicBaseUrl === "function"
      ? await config.publicBaseUrl(context)
      : config.publicBaseUrl;

  if (!publicBaseUrl) {
    throw new Error("CloudFront publicBaseUrl resolver returned an empty URL");
  }

  return publicBaseUrl;
};

export const withCloudFrontSignedUrl = <TContext = unknown>(
  storageFactory: () => StoragePlugin<TContext>,
  config: WithCloudFrontSignedUrlOptions<TContext>,
) => {
  return (): StoragePlugin<TContext> => {
    const baseStorage = storageFactory();

    return {
      ...baseStorage,
      name: `${baseStorage.name}WithCloudFrontSignedUrl`,
      async getDownloadUrl(storageUri, context) {
        const storageUrl = new URL(storageUri);

        if (storageUrl.protocol !== "s3:") {
          return baseStorage.getDownloadUrl(storageUri, context);
        }

        const [privateKey, publicBaseUrl] = await Promise.all([
          resolvePrivateKey(config),
          resolvePublicBaseUrl(config, context),
        ]);
        const url = new URL(publicBaseUrl);
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
