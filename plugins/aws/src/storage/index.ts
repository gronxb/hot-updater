import { StoragePluginError } from "@hot-updater/plugin-core/storage";

import type { S3StorageConfig } from "./types";

export type { S3StorageConfig } from "./types";

export const s3Storage = (_config: S3StorageConfig): never => {
  throw new StoragePluginError(
    "unsupported",
    "AWS S3 Storage v2 requires the node export condition.",
  );
};
