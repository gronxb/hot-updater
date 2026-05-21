import {
  createUniversalStoragePlugin,
  type StoragePluginHooks,
  type UniversalStoragePlugin,
} from "@hot-updater/plugin-core";

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
interface R2Storage {
  (
    config: R2S3StorageConfig,
    hooks?: StoragePluginHooks,
  ): () => UniversalStoragePlugin;
  /**
   * @deprecated `cloudflareApiToken` uses the Wrangler CLI for R2 operations,
   * which is slower than direct S3-compatible API access. Create R2
   * S3-compatible credentials in the Cloudflare dashboard and pass them with
   * `r2Storage({ credentials })` instead.
   */
  (
    config: R2WranglerStorageConfig,
    hooks?: StoragePluginHooks,
  ): () => UniversalStoragePlugin;
}

const createR2StoragePlugin = createUniversalStoragePlugin<R2StorageConfig>({
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

export const r2Storage: R2Storage = createR2StoragePlugin;
