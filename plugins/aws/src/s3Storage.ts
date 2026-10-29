import type { S3ClientConfig } from "@aws-sdk/client-s3";
import type {
  StorageAdapter,
  StorageAdapterWith,
} from "@hot-updater/plugin-core";
import {
  createS3Storage,
  type S3StorageOperations,
} from "@hot-updater/storage-s3";

import type { AwsCredentialsOption } from "./lazyCredentials";
import { applyS3RuntimeAwsConfig } from "./runtimeAwsConfig";

export interface S3StorageConfig extends Omit<S3ClientConfig, "credentials"> {
  /** The SDK's credentials, or access keys whose fields are lazy. */
  credentials?: AwsCredentialsOption;
  bucketName: string;
  /** Base path where bundles will be stored in the bucket. */
  basePath?: string;
  /**
   * The URL devices download an object from, such as
   * `cloudFrontDownloadUrl(...)`. Without it, a presigned S3 URL that
   * expires in an hour.
   */
  getDownloadUrl?: StorageAdapter["getDownloadUrl"];
}

export function s3Storage(
  config: S3StorageConfig,
): StorageAdapterWith<S3StorageOperations> {
  const { bucketName, basePath, getDownloadUrl, credentials, ...s3Config } =
    config;
  return createS3Storage(
    { name: "s3Storage", protocol: "s3" },
    {
      ...applyS3RuntimeAwsConfig(s3Config),
      credentials,
      bucketName,
      basePath,
      getDownloadUrl,
    },
  );
}
