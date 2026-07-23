import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import {
  createBlobDatabasePlugin,
  type DatabasePluginLifecycleHooks,
} from "@hot-updater/plugin-core";

import { invalidateCloudFront } from "./cloudFrontInvalidation";
import { applyS3RuntimeAwsConfig } from "./runtimeAwsConfig";
import {
  ArchivedS3DatabaseObjectError,
  compareAndSwapJsonInS3,
  listS3DatabaseObjects,
  loadJsonFromS3,
  uploadJsonToS3,
} from "./s3DatabaseObjects";

export interface S3DatabaseConfig extends S3ClientConfig {
  readonly bucketName: string;
  readonly basePath?: string;
  readonly cloudfrontDistributionId?: string;
  readonly shouldWaitForInvalidation?: boolean;
  readonly apiBasePath?: string;
}

const normalizeBasePath = (basePath: string | undefined): string =>
  basePath?.replace(/^\/+|\/+$/g, "") ?? "";

const createKeyBuilder = (basePath: string | undefined) => {
  const root = normalizeBasePath(basePath);
  return {
    root,
    toStorageKey: (key: string): string =>
      [root, key].filter(Boolean).join("/"),
    fromStorageKey: (key: string): string => {
      if (!root) return key;
      const prefix = `${root}/`;
      return key.startsWith(prefix) ? key.slice(prefix.length) : key;
    },
  };
};

export const s3Database = (
  config: S3DatabaseConfig,
  hooks?: DatabasePluginLifecycleHooks,
) =>
  createBlobDatabasePlugin({
    name: "s3Database",
    onDatabaseUpdated: hooks?.onDatabaseUpdated,
    plugin: () => {
      const {
        apiBasePath = "/api/check-update",
        basePath,
        bucketName,
        cloudfrontDistributionId,
        shouldWaitForInvalidation = false,
        ...clientConfig
      } = config;
      const client = new S3Client(applyS3RuntimeAwsConfig(clientConfig));
      const keys = createKeyBuilder(basePath);
      const cloudFront = cloudfrontDistributionId
        ? new CloudFrontClient({
            credentials: clientConfig.credentials,
            region: clientConfig.region,
          })
        : null;
      return {
        apiBasePath,
        listObjects: async (prefix) =>
          (
            await listS3DatabaseObjects(
              client,
              bucketName,
              keys.toStorageKey(prefix),
            )
          ).map(keys.fromStorageKey),
        loadObject: (key) =>
          loadJsonFromS3(client, bucketName, keys.toStorageKey(key)),
        uploadObject: (key, data) =>
          uploadJsonToS3(client, bucketName, keys.toStorageKey(key), data),
        compareAndSwapObject: (key, expected, data) =>
          compareAndSwapJsonInS3(
            client,
            bucketName,
            keys.toStorageKey(key),
            expected,
            data,
          ),
        shouldSkipLoadObjectError: (error, key) =>
          error instanceof ArchivedS3DatabaseObjectError &&
          key.endsWith("/update.json") &&
          !key.startsWith("_hot-updater/database/"),
        invalidatePaths: (paths) =>
          cloudFront && cloudfrontDistributionId
            ? invalidateCloudFront(
                cloudFront,
                cloudfrontDistributionId,
                paths,
                {
                  shouldWait: shouldWaitForInvalidation,
                },
              )
            : Promise.resolve(),
      };
    },
  });
