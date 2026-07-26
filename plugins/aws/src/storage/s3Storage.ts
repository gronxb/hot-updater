import {
  createStoragePlugin,
  type StoragePlugin,
} from "@hot-updater/plugin-core/storage";

import { createS3ClientOwner } from "./client";
import { createDeliveryOperation } from "./delivery";
import type { S3OperationEnvironment } from "./operationEnvironment";
import { createReadOperations } from "./readOperations";
import type { S3StorageConfig } from "./types";
import { createWriteOperations } from "./writeOperations";

const createStorage = (
  config: S3StorageConfig,
  target: S3OperationEnvironment["target"],
): StoragePlugin => {
  const owner = createS3ClientOwner(config);
  const environment = { owner, target };
  return createStoragePlugin({
    name: "s3Storage",
    protocol: "s3",
    plugin: () => ({
      ...createWriteOperations(environment),
      ...createReadOperations(environment),
      ...createDeliveryOperation(environment, config.delivery !== undefined),
      onUnmount: owner.onUnmount,
    }),
  });
};

export const createS3Storage = (config: S3StorageConfig): StoragePlugin =>
  createStorage(config, "node");

export const createLambdaS3Storage = (config: S3StorageConfig): StoragePlugin =>
  createStorage(config, "functions");
