import type { StoragePluginHooks } from "@hot-updater/plugin-core";

import type { S3StorageConfig } from "./s3Storage";
import { s3Storage } from "./s3Storage";
import {
  type WithCloudFrontSignedUrlOptions,
  withCloudFrontSignedUrl,
} from "./withCloudFrontSignedUrl";

export type AwsLambdaEdgeStorageConfig = S3StorageConfig &
  WithCloudFrontSignedUrlOptions;

export const awsLambdaEdgeStorage = (
  config: AwsLambdaEdgeStorageConfig,
  hooks?: StoragePluginHooks,
) => {
  return withCloudFrontSignedUrl(s3Storage(config, hooks), config);
};

export const s3LambdaEdgeStorage = awsLambdaEdgeStorage;
