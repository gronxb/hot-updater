import type { StoragePlugin } from "@hot-updater/plugin-core/storage";

import type { SupabaseStorageConfig } from "./config";
import { createSupabaseStorage } from "./factory";

export type { SupabaseStorageConfig } from "./config";
export { SupabaseStorageError } from "./errors";

export const supabaseStorage = (config: SupabaseStorageConfig): StoragePlugin =>
  createSupabaseStorage(config, ["node"]);
