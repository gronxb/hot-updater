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

type SupabaseStorageBucket = {
  createSignedUrl: (
    path: string,
    expiresIn: number,
  ) => Promise<{
    data: { signedUrl?: string } | null;
    error?: unknown;
  }>;
};

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

async function createSignedUrlOrThrow({
  bucket,
  key,
  expiresIn,
}: {
  bucket: SupabaseStorageBucket;
  key: string;
  expiresIn: number;
}) {
  let data: { signedUrl?: string } | null = null;
  let error: unknown = null;
  try {
    const response = await bucket.createSignedUrl(key, expiresIn);
    data = response.data;
    error = response.error;
  } catch (thrownError) {
    error = thrownError;
  }

  if (!error && data?.signedUrl) {
    return data.signedUrl;
  }

  throw new Error(
    `Failed to generate download URL for "${key}": ${getErrorMessage(error ?? new Error("missing signed URL"))}`,
  );
}

async function verifyObjectCanBeSignedForRuntime({
  bucket,
  key,
}: {
  bucket: SupabaseStorageBucket;
  key: string;
}) {
  await createSignedUrlOrThrow({
    bucket,
    key,
    expiresIn: 3600,
  });
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

            await verifyObjectCanBeSignedForRuntime({
              bucket,
              key: Key,
            });

            const fullPath = upload.data?.fullPath;
            if (!fullPath) {
              throw new Error("Supabase storage upload did not return a path");
            }

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

            await verifyObjectCanBeSignedForRuntime({
              bucket,
              key,
            });

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

            const signedUrl = await createSignedUrlOrThrow({
              bucket,
              key,
              expiresIn: 3600,
            });

            return { fileUrl: signedUrl };
          },
        },
      };
    },
  });
