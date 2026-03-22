import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import type {
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";
import type { S3StorageConfig } from "./s3Storage";
import { s3Storage } from "./s3Storage";

const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365;

export interface AwsLambdaEdgeStorageConfig extends S3StorageConfig {
  keyPairId: string;
  getPrivateKey: () => Promise<string>;
  publicBaseUrl: string;
  expiresSeconds?: number;
}

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

        const privateKey = await config.getPrivateKey();
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
