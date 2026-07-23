import type { StoragePluginHooks } from "@hot-updater/plugin-core";

import type { S3StorageConfig } from "./s3Storage";
import { s3Storage } from "./s3Storage";
import {
  type WithCloudFrontSignedUrlOptions,
  withCloudFrontSignedUrl,
} from "./withCloudFrontSignedUrl";

export type AwsLambdaEdgeStorageConfig<TContext = unknown> = S3StorageConfig &
  WithCloudFrontSignedUrlOptions<TContext>;

export const awsLambdaEdgeStorage = <TContext = unknown>(
  config: AwsLambdaEdgeStorageConfig<TContext>,
  hooks?: StoragePluginHooks,
) => {
  return withCloudFrontSignedUrl<TContext>(s3Storage(config, hooks), config);
};

export const s3LambdaEdgeStorage = awsLambdaEdgeStorage;
