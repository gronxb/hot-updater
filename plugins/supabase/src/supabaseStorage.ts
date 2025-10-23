import {
  type BasePluginArgs,
  createStorageKeyBuilder,
  parseStorageUri,
  type StoragePlugin,
  type StoragePluginHooks,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";
import fs from "fs/promises";
import mime from "mime";
import path from "path";
import type { Database } from "./types";

export interface SupabaseStorageConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  bucketName: string;
  /**
   * Base path where bundles will be stored in the bucket
   */
  basePath?: string;
}

export const supabaseStorage =
  (config: SupabaseStorageConfig, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {
    const supabase = createClient<Database>(
      config.supabaseUrl,
      config.supabaseAnonKey,
    );

    const bucket = supabase.storage.from(config.bucketName);
    const getStorageKey = createStorageKeyBuilder(config.basePath);
    return {
      name: "supabaseStorage",
      supportedProtocol: "supabase-storage",
      async delete(storageUri) {
        const { key, bucket: bucketName } = parseStorageUri(
          storageUri,
          "supabase-storage",
        );
        if (bucketName !== config.bucketName) {
          throw new Error(
            `Bucket name mismatch: expected "${config.bucketName}", but found "${bucketName}".`,
          );
        }

        const { error } = await bucket.remove([key]);

        if (error) {
          if (error.message?.includes("not found")) {
            throw new Error(`Bundle not found`);
          }
          throw new Error(`Failed to delete bundle: ${error.message}`);
        }
      },

      async upload(key, filePath) {
        const Body = await fs.readFile(filePath);
        const ContentType = mime.getType(filePath) ?? void 0;

        const filename = path.basename(filePath);

        const Key = getStorageKey(key, filename);

        const upload = await bucket.upload(Key, Body, {
          contentType: ContentType,
        });
        if (upload.error) {
          throw upload.error;
        }

        const fullPath = upload.data.fullPath;

        hooks?.onStorageUploaded?.();
        return {
          storageUri: `supabase-storage://${fullPath}`,
        };
      },
      async getDownloadUrl(storageUri: string) {
        // Simple validation: supported protocol must match
        const u = new URL(storageUri);
        if (u.protocol.replace(":", "") !== "supabase-storage") {
          throw new Error("Invalid Supabase storage URI protocol");
        }
        // Extract key without bucket prefix if present
        let key = `${u.host}${u.pathname}`.replace(/^\//, "");
        if (!key) {
          throw new Error("Invalid Supabase storage URI: missing key");
        }
        if (key.startsWith(`${config.bucketName}/`)) {
          key = key.substring(`${config.bucketName}/`.length);
        }
        const { data, error } = await bucket.createSignedUrl(key, 3600);
        if (error) {
          throw new Error(`Failed to generate download URL: ${error.message}`);
        }
        if (!data?.signedUrl) {
          throw new Error("Failed to generate download URL");
        }
        return { fileUrl: data.signedUrl };
      },
    };
  };
