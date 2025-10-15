import {
  type BasePluginArgs,
  createStorageKeyBuilder,
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
      async deleteBundle(bundleId) {
        const filename = "bundle.zip";
        const Key = getStorageKey(bundleId, filename);

        const { error } = await bucket.remove([Key]);

        if (error) {
          if (error.message?.includes("not found")) {
            throw new Error(`Bundle with id ${bundleId} not found`);
          }
          throw new Error(`Failed to delete bundle: ${error.message}`);
        }
        return {
          storageUri: `supabase-storage://${config.bucketName}/${Key}`,
        };
      },

      async uploadBundle(bundleId, bundlePath) {
        const Body = await fs.readFile(bundlePath);
        const ContentType = mime.getType(bundlePath) ?? void 0;

        const filename = path.basename(bundlePath);

        // Detect Content-Encoding based on file extension
        let contentEncoding: string | undefined;
        if (filename.endsWith(".tar.gz") || filename.endsWith(".tgz")) {
          contentEncoding = "gzip";
        } else if (filename.endsWith(".tar.br") || filename.endsWith(".br")) {
          contentEncoding = "br";
        }

        const Key = getStorageKey(bundleId, filename);

        const uploadOptions: {
          contentType?: string;
          cacheControl: string;
          httpHeaders?: Record<string, string>;
        } = {
          contentType: ContentType,
          cacheControl: "max-age=31536000",
        };

        if (contentEncoding) {
          uploadOptions.httpHeaders = {
            "Content-Encoding": contentEncoding,
          };
        }

        const upload = await bucket.upload(Key, Body, uploadOptions);
        if (upload.error) {
          throw upload.error;
        }

        const fullPath = upload.data.fullPath;

        hooks?.onStorageUploaded?.();
        return {
          storageUri: `supabase-storage://${fullPath}`,
        };
      },
    };
  };
