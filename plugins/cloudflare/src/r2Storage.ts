import type { StorageAdapterWith } from "@hot-updater/plugin-core";

import { createR2S3Storage, type R2S3StorageConfig } from "./r2S3Storage";

export type R2StorageConfig = R2S3StorageConfig;
export type { R2S3StorageConfig };

export const r2Storage = (
  config: R2S3StorageConfig,
): StorageAdapterWith<
  "put" | "get" | "getDownloadUrl" | "exists" | "delete"
> => {
  if (!config.credentials) {
    throw new Error(
      "r2Storage requires S3-compatible credentials: pass credentials with an R2 access key ID and secret access key.",
    );
  }

  return createR2S3Storage(config);
};
