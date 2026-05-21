import { createUniversalStoragePlugin } from "@hot-updater/plugin-core";

import {
  createS3RuntimeStorageProfile,
  createS3StorageProfile,
  type R2S3StorageConfig,
} from "./r2S3Storage";
import {
  createWranglerRuntimeStorageProfile,
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
export const r2Storage = createUniversalStoragePlugin<R2StorageConfig>({
  name: "r2Storage",
  supportedProtocol: "r2",
  factory: (config) => {
    if (hasS3Credentials(config)) {
      return {
        node: createS3StorageProfile(config),
        runtime: createS3RuntimeStorageProfile(config),
      };
    }

    return {
      node: createWranglerStorageProfile(config),
      runtime: createWranglerRuntimeStorageProfile(),
    };
  },
});
