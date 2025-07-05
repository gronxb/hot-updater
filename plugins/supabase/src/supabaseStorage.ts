import path from "path";
import type {
  BasePluginArgs,
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";
import fs from "fs/promises";
import mime from "mime";
import type { Database } from "./types";

export interface SupabaseStorageConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  bucketName: string;
}

export const supabaseStorage =
  (config: SupabaseStorageConfig, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {
    const supabase = createClient<Database>(
      config.supabaseUrl,
      config.supabaseAnonKey,
    );

    const bucket = supabase.storage.from(config.bucketName);
    return {
      name: "supabaseStorage",
      async deleteBundle(bundleId) {
        const filename = "bundle.zip";
        const Key = `${bundleId}/${filename}`;

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

        const Key = [bundleId, filename].join("/");

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

      // Native build operations
      async uploadNativeBuild(nativeBuildId, nativeBuildPath) {
        const Body = await fs.readFile(nativeBuildPath);
        const ContentType = mime.getType(nativeBuildPath) ?? void 0;

        const filename = path.basename(nativeBuildPath);
        const Key = `native-builds/${nativeBuildId}/${filename}`;

        const upload = await bucket.upload(Key, Body, {
          contentType: ContentType,
        });
        if (upload.error) {
          throw new Error(`Failed to upload native build: ${upload.error.message}`);
        }

        const fullPath = upload.data.fullPath;

        hooks?.onStorageUploaded?.();
        return {
          storageUri: `supabase-storage://${fullPath}`,
        };
      },

      async deleteNativeBuild(nativeBuildId) {
        const prefix = `native-builds/${nativeBuildId}`;
        
        // List files in the directory
        const { data: files, error: listError } = await bucket.list(prefix);
        
        if (listError) {
          throw new Error(`Failed to list native build files: ${listError.message}`);
        }

        if (!files || files.length === 0) {
          throw new Error("Native build not found");
        }

        // Delete all files in the directory
        const filePaths = files.map(file => `${prefix}/${file.name}`);
        const { error } = await bucket.remove(filePaths);

        if (error) {
          throw new Error(`Failed to delete native build: ${error.message}`);
        }

        return {
          storageUri: `supabase-storage://${config.bucketName}/${prefix}`,
        };
      },

      async getNativeBuildDownloadUrl(nativeBuildId) {
        const prefix = `native-builds/${nativeBuildId}`;
        
        // List files in the directory
        const { data: files, error: listError } = await bucket.list(prefix);
        
        if (listError) {
          throw new Error(`Failed to list native build files: ${listError.message}`);
        }

        if (!files || files.length === 0) {
          throw new Error("Native build not found");
        }

        // Get the first file (should be the native build artifact)
        const firstFile = files[0];
        const filePath = `${prefix}/${firstFile.name}`;

        // Generate signed URL valid for 1 hour
        const { data, error } = await bucket.createSignedUrl(filePath, 3600); // 1 hour

        if (error) {
          throw new Error(`Failed to generate download URL: ${error.message}`);
        }

        return {
          fileUrl: data.signedUrl,
        };
      },
    };
  };
