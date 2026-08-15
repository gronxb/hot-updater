import type { StoragePluginWith } from "@hot-updater/plugin-core";

import { createR2S3Storage, type R2S3StorageConfig } from "./r2S3Storage";
import {
  createR2WranglerStorage,
  type R2WranglerStorageConfig,
} from "./r2WranglerStorage";

export type R2StorageConfig = R2S3StorageConfig | R2WranglerStorageConfig;
export type { R2S3StorageConfig, R2WranglerStorageConfig };

const hasS3Credentials = (
  config: R2StorageConfig,
): config is R2S3StorageConfig => Boolean(config.credentials);

interface R2Storage {
  (
    config: R2S3StorageConfig,
  ): StoragePluginWith<"put" | "get" | "exists" | "delete">;
  /** @deprecated Use R2 S3-compatible credentials instead. */
  (
    config: R2WranglerStorageConfig,
  ): StoragePluginWith<"put" | "get" | "exists" | "delete">;
}

export const r2Storage: R2Storage = (config: R2StorageConfig) =>
  hasS3Credentials(config)
    ? createR2S3Storage(config)
    : createR2WranglerStorage(config);
