import { createNodeStoragePlugin } from "@hot-updater/plugin-core";

import { createS3StorageProfile, type R2S3StorageConfig } from "./r2S3Storage";
import {
  createWranglerStorageProfile,
  type R2WranglerStorageConfig,
} from "./r2WranglerStorage";

export type R2StorageConfig = R2S3StorageConfig | R2WranglerStorageConfig;

export type { R2S3StorageConfig, R2WranglerStorageConfig };

const hasS3Credentials = (
  config: R2StorageConfig,
): config is R2S3StorageConfig => {
  return Boolean(config.credentials);
};

/**
 * Cloudflare R2 storage plugin for Hot Updater.
 */
export const r2Storage = createNodeStoragePlugin<R2StorageConfig>({
  name: "r2Storage",
  supportedProtocol: "r2",
  factory: (config) => {
    if (hasS3Credentials(config)) {
      return createS3StorageProfile(config);
    }

    return createWranglerStorageProfile(config);
  },
});
