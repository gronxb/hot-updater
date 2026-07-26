import { StoragePluginError } from "@hot-updater/plugin-core/storage";

import type { R2NodeStorageConfig } from "./nodeTypes";

export const r2Storage = (_config: R2NodeStorageConfig): never => {
  throw new StoragePluginError(
    "unsupported",
    "Cloudflare R2 storage is unsupported in this runtime.",
  );
};

export type { R2NodeStorageConfig } from "./nodeTypes";
