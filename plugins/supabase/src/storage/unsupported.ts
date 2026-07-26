import {
  StoragePluginError,
  type StoragePlugin,
} from "@hot-updater/plugin-core/storage";

import type { SupabaseStorageConfig } from "./config";

export type { SupabaseStorageConfig } from "./config";

export const supabaseStorage = (
  _config: SupabaseStorageConfig,
): StoragePlugin => {
  throw new StoragePluginError(
    "unsupported",
    "Supabase storage requires a node, worker, or edge runtime condition.",
  );
};
