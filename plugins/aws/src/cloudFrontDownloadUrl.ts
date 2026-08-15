import { SSM } from "@aws-sdk/client-ssm";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";

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

export type CloudFrontDownloadUrlOptions = (
  | CloudFrontPrivateKeyFromGetter
  | CloudFrontPrivateKeyFromSsm
) & {
  keyPairId: string;
  publicBaseUrl: string;
  expiresSeconds?: number;
};

const privateKeyCache = new Map<string, Promise<string>>();

const getPrivateKeyFromSsm = async (region: string, parameterName: string) => {
  const response = await new SSM(
    applySsmRuntimeAwsConfig({ region }),
  ).getParameter({ Name: parameterName, WithDecryption: true });
  const value = response.Parameter?.Value;
  if (!value) {
    throw new Error(`CloudFront private key is missing: ${parameterName}`);
  }

  const privateKey = (JSON.parse(value) as { privateKey?: unknown }).privateKey;
  if (typeof privateKey !== "string" || privateKey.length === 0) {
    throw new Error(`Invalid CloudFront private key: ${parameterName}`);
  }
  return privateKey;
};

const resolvePrivateKey = (config: CloudFrontDownloadUrlOptions) => {
  if (config.getPrivateKey) return config.getPrivateKey();

  const cacheKey = `${config.ssmRegion}:${config.ssmParameterName}`;
  const cached = privateKeyCache.get(cacheKey);
  if (cached) return cached;

  const pending = getPrivateKeyFromSsm(
    config.ssmRegion,
    config.ssmParameterName,
  ).catch((error) => {
    privateKeyCache.delete(cacheKey);
    throw error;
  });
  privateKeyCache.set(cacheKey, pending);
  return pending;
};

export const cloudFrontDownloadUrl =
  (config: CloudFrontDownloadUrlOptions) =>
  async ({ storageUri }: { storageUri: string }) => {
    const storageUrl = new URL(storageUri);
    if (storageUrl.protocol !== "s3:") {
      throw new Error("CloudFront download URLs require an s3 storage URI.");
    }

    const url = new URL(config.publicBaseUrl);
    url.pathname = storageUrl.pathname;
    url.search = "";
    return {
      url: getSignedUrl({
        url: url.toString(),
        keyPairId: config.keyPairId,
        privateKey: await resolvePrivateKey(config),
        dateLessThan: new Date(
          Date.now() + (config.expiresSeconds ?? ONE_YEAR_IN_SECONDS) * 1000,
        ).toISOString(),
      }),
    };
  };
