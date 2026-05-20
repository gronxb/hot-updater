import fs from "fs/promises";
import path from "path";

import {
  createStorageKeyBuilder,
  createUniversalStoragePlugin,
  getContentType,
  parseStorageUri,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";

import {
  resolveSupabaseServiceRoleKey,
  type SupabaseServiceRoleConfig,
} from "./supabaseConfig";
import type { Database } from "./types";

const signedUrlRetryDelays = [100, 250, 500, 1000, 2000] as const;

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function isObjectNotFoundError(error: unknown) {
  return getErrorMessage(error).toLowerCase().includes("object not found");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SupabaseStorageConfig = SupabaseServiceRoleConfig & {
  bucketName: string;
  /**
   * Base path where bundles will be stored in the bucket
   */
  basePath?: string;
};

export const supabaseStorage =
  createUniversalStoragePlugin<SupabaseStorageConfig>({
    name: "supabaseStorage",
    supportedProtocol: "supabase-storage",
    factory: (config) => {
      const supabase = createClient<Database>(
        config.supabaseUrl,
        resolveSupabaseServiceRoleKey(config),
      );

      const bucket = supabase.storage.from(config.bucketName);
      const getStorageKey = createStorageKeyBuilder(config.basePath);

      return {
        node: {
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
            const ContentType = getContentType(filePath);

            const filename = path.basename(filePath);

            const Key = getStorageKey(key, filename);

            const upload = await bucket.upload(Key, Body, {
              contentType: ContentType,
              cacheControl: "max-age=31536000",
              headers: {},
            });
            if (upload.error) {
              throw upload.error;
            }

            const fullPath = upload.data.fullPath;

            return {
              storageUri: `supabase-storage://${fullPath}`,
            };
          },
          async exists(storageUri: string) {
            const { key, bucket: bucketName } = parseStorageUri(
              storageUri,
              "supabase-storage",
            );
            if (bucketName !== config.bucketName) {
              throw new Error(
                `Bucket name mismatch: expected "${config.bucketName}", but found "${bucketName}".`,
              );
            }

            const { data, error } = await bucket.exists(key);
            if (data === false) {
              return false;
            }
            if (error) {
              throw error;
            }

            return data;
          },
          async downloadFile(storageUri: string, filePath: string) {
            const { key, bucket: bucketName } = parseStorageUri(
              storageUri,
              "supabase-storage",
            );
            if (bucketName !== config.bucketName) {
              throw new Error(
                `Bucket name mismatch: expected "${config.bucketName}", but found "${bucketName}".`,
              );
            }

            const { data, error } = await bucket.download(key);
            if (error) {
              throw new Error(`Failed to download bundle: ${error.message}`);
            }
            if (!data) {
              throw new Error("Failed to download bundle");
            }

            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(
              filePath,
              new Uint8Array(await data.arrayBuffer()),
            );
          },
        },
        runtime: {
          async readText(storageUri: string) {
            const { key, bucket: bucketName } = parseStorageUri(
              storageUri,
              "supabase-storage",
            );
            if (bucketName !== config.bucketName) {
              throw new Error(
                `Bucket name mismatch: expected "${config.bucketName}", but found "${bucketName}".`,
              );
            }

            const { data, error } = await bucket.download(key);
            if (error) {
              if (error.message?.includes("not found")) {
                return null;
              }

              throw new Error(`Failed to read storage text: ${error.message}`);
            }
            if (!data) {
              return null;
            }

            return data.text();
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

            let lastError: unknown;
            for (
              let attempt = 0;
              attempt <= signedUrlRetryDelays.length;
              attempt++
            ) {
              let data: { signedUrl?: string } | null = null;
              let error: unknown = null;
              try {
                const response = await bucket.createSignedUrl(key, 3600);
                data = response.data;
                error = response.error;
              } catch (thrownError) {
                error = thrownError;
              }
              if (!error && data?.signedUrl) {
                return { fileUrl: data.signedUrl };
              }

              lastError = error ?? new Error("missing signed URL");
              if (error && !isObjectNotFoundError(error)) {
                throw new Error(
                  `Failed to generate download URL for "${key}": ${getErrorMessage(error)}`,
                );
              }

              const retryDelay = signedUrlRetryDelays[attempt];
              if (retryDelay === undefined) {
                break;
              }
              await delay(retryDelay);
            }

            throw new Error(
              `Failed to generate download URL for "${key}": ${getErrorMessage(lastError)}`,
            );
          },
        },
      };
    },
  });
