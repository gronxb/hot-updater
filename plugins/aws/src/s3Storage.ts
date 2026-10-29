import type { S3ClientConfig } from "@aws-sdk/client-s3";
import type {
  StorageAdapter,
  StorageAdapterWith,
} from "@hot-updater/plugin-core";
import {
  createS3Storage,
  type S3StorageOperations,
} from "@hot-updater/storage-s3";

import { applyS3RuntimeAwsConfig } from "./runtimeAwsConfig";

export interface S3StorageConfig extends S3ClientConfig {
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
  const { bucketName, basePath, getDownloadUrl, ...s3Config } = config;
  return createS3Storage(
    { name: "s3Storage", protocol: "s3" },
    {
      ...applyS3RuntimeAwsConfig(s3Config),
      bucketName,
      basePath,
      getDownloadUrl,
    },
  );
}
