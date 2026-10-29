import type { StorageAdapterWith } from "@hot-updater/plugin-core";
import {
  createS3Storage,
  type S3ClientConfig,
  type S3CredentialsOption,
  type S3StorageOperations,
} from "@hot-updater/storage-s3";

export interface R2S3StorageConfig extends Omit<S3ClientConfig, "credentials"> {
  accountId: string;
  bucketName: string;
  /** The SDK's credentials, or an R2 access key whose fields are lazy. */
  credentials: NonNullable<S3CredentialsOption>;
  /** Base path where bundles will be stored in the bucket. */
  basePath?: string;
}

export const createR2S3Storage = (
  config: R2S3StorageConfig,
): StorageAdapterWith<S3StorageOperations> => {
  const { accountId, endpoint, forcePathStyle, region, ...s3Config } = config;
  return createS3Storage(
    { name: "r2Storage", protocol: "r2" },
    {
      ...s3Config,
      endpoint: endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: forcePathStyle ?? true,
      region: region ?? "auto",
    },
  );
};
