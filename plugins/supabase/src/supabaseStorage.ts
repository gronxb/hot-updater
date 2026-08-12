import {
  createStorageKeyBuilder,
  createStoragePlugin,
  parseStorageUri,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";

import {
  resolveSupabaseServiceRoleKey,
  type SupabaseServiceRoleConfig,
} from "./supabaseConfig";
import type { Database } from "./types";

const isNotFoundError = (error: { message?: string } | null | undefined) =>
  error?.message?.toLowerCase().includes("not found") === true;

export type SupabaseStorageConfig = SupabaseServiceRoleConfig & {
  bucketName: string;
  /** Base path where bundles will be stored in the bucket. */
  basePath?: string;
};

export const supabaseStorage = (
  config: SupabaseStorageConfig,
): StoragePluginWith<"put" | "get" | "exists" | "delete"> => {
  const supabase = createClient<Database>(
    config.supabaseUrl,
    resolveSupabaseServiceRoleKey(config),
  );
  const bucket = supabase.storage.from(config.bucketName);
  const getStorageKey = createStorageKeyBuilder(config.basePath);

  const parseAndValidate = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, "supabase-storage");
    if (parsed.bucket !== config.bucketName) {
      throw new Error(
        `Bucket name mismatch: expected "${config.bucketName}", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  return createStoragePlugin({
    name: "supabaseStorage",
    protocol: "supabase-storage",
    async put({ key, body, contentType }) {
      const storageKey = getStorageKey(key);
      const { data, error } = await bucket.upload(storageKey, body, {
        contentType,
        cacheControl: "max-age=31536000",
      });
      if (error) throw error;
      return {
        storageUri: `supabase-storage://${data.fullPath}`,
      };
    },
    async get(storageUri) {
      const { key } = parseAndValidate(storageUri);
      const { data, error } = await bucket.download(key);
      if (error) {
        if (isNotFoundError(error)) return null;
        throw new Error(`Failed to download storage object: ${error.message}`);
      }
      return data ? new Response(data) : null;
    },
    async exists(storageUri) {
      const { key } = parseAndValidate(storageUri);
      const { data, error } = await bucket.exists(key);
      if (error) throw error;
      return data;
    },
    async delete(storageUri) {
      const { key } = parseAndValidate(storageUri);
      const { error } = await bucket.remove([key]);
      if (error && !isNotFoundError(error)) {
        throw new Error(`Failed to delete storage object: ${error.message}`);
      }
    },
  });
};
