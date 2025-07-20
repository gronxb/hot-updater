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

      async upload(key: string, filePath: string) {
        const Body = await fs.readFile(filePath);
        const ContentType = mime.getType(filePath) ?? void 0;

        const filename = path.basename(filePath);
        const Key = [key, filename].join("/");

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

      async delete(storageUri: string) {
        // Parse supabase-storage://bucket-name/key or supabase-storage://key from storageUri
        const match = storageUri.match(/^supabase-storage:\/\/(.+)$/);
        if (!match) {
          throw new Error("Invalid Supabase storage URI format");
        }

        const fullPath = match[1];
        // Extract the key part after bucket name if it includes bucket name
        let key = fullPath;
        if (fullPath.startsWith(`${config.bucketName}/`)) {
          key = fullPath.substring(`${config.bucketName}/`.length);
        }

        // Try to remove as a single file first
        const { error: singleFileError } = await bucket.remove([key]);

        if (singleFileError?.message?.includes("not found")) {
          // If single file removal fails, try to list and remove directory contents
          const { data: files, error: listError } = await bucket.list(key);

          if (listError) {
            throw new Error(`File not found in storage: ${listError.message}`);
          }

          if (!files || files.length === 0) {
            throw new Error("File not found in storage");
          }

          // Delete all files in the directory
          const filePaths = files.map((file) => `${key}/${file.name}`);
          const { error } = await bucket.remove(filePaths);

          if (error) {
            throw new Error(`Failed to delete files: ${error.message}`);
          }
        } else if (singleFileError) {
          throw new Error(`Failed to delete file: ${singleFileError.message}`);
        }
      },

      async getDownloadUrl(storageUri: string) {
        // Parse supabase-storage://bucket-name/key or supabase-storage://key from storageUri
        const match = storageUri.match(/^supabase-storage:\/\/(.+)$/);
        if (!match) {
          throw new Error("Invalid Supabase storage URI format");
        }

        const fullPath = match[1];
        // Extract the key part after bucket name if it includes bucket name
        let key = fullPath;
        if (fullPath.startsWith(`${config.bucketName}/`)) {
          key = fullPath.substring(`${config.bucketName}/`.length);
        }

        // If key represents a directory prefix, find the actual file
        let actualKey = key;
        if (!key.includes(".")) {
          const { data: files, error: listError } = await bucket.list(key);

          if (listError) {
            throw new Error(`Failed to list files: ${listError.message}`);
          }

          if (!files || files.length === 0) {
            throw new Error("File not found in storage");
          }

          // Get the first file (should be the actual file)
          const firstFile = files[0];
          actualKey = `${key}/${firstFile.name}`;
        }

        // Generate signed URL valid for 1 hour
        const { data, error } = await bucket.createSignedUrl(actualKey, 3600); // 1 hour

        if (error) {
          throw new Error(`Failed to generate download URL: ${error.message}`);
        }

        return {
          fileUrl: data.signedUrl,
        };
      },
    };
  };
