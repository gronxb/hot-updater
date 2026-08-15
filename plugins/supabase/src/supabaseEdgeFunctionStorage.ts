import type { StoragePluginWith } from "@hot-updater/plugin-core";

import { supabaseStorage } from "./supabaseStorage";

export interface SupabaseEdgeFunctionStorageConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  bucketName: string;
  basePath?: string;
  signedUrlExpiresIn?: number;
}

export const supabaseEdgeFunctionStorage = (
  config: SupabaseEdgeFunctionStorageConfig,
): StoragePluginWith<"put" | "get" | "getDownloadUrl" | "exists" | "delete"> =>
  supabaseStorage(config);
