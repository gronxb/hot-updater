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
const uploadedObjectSignedUrlRetryDelays = [
  100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000,
] as const;

type SupabaseStorageBucket = {
  createSignedUrl: (
    path: string,
    expiresIn: number,
  ) => Promise<{
    data: { signedUrl?: string } | null;
    error?: unknown;
  }>;
  download: (path: string) => Promise<{
    data: { arrayBuffer: () => Promise<ArrayBuffer> } | null;
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

function isObjectNotFoundError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("object not found") || message.includes("not found")) {
    return true;
  }
  return (
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    (error.statusCode === "404" || error.statusCode === 404)
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createSignedUrlWithRetry({
  bucket,
  key,
  expiresIn,
  retryDelays,
}: {
  bucket: SupabaseStorageBucket;
  key: string;
  expiresIn: number;
  retryDelays: readonly number[];
}) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
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

    lastError = error ?? new Error("missing signed URL");
    if (error && !isObjectNotFoundError(error)) {
      throw new Error(
        `Failed to generate download URL for "${key}": ${getErrorMessage(error)}`,
      );
    }

    const retryDelay = retryDelays[attempt];
    if (retryDelay === undefined) {
      break;
    }
    await delay(retryDelay);
  }

  throw new Error(
    `Failed to generate download URL for "${key}": ${getErrorMessage(lastError)}`,
  );
}

async function downloadWithRetry({
  bucket,
  key,
  retryDelays,
}: {
  bucket: SupabaseStorageBucket;
  key: string;
  retryDelays: readonly number[];
}) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    let data: { arrayBuffer: () => Promise<ArrayBuffer> } | null = null;
    let error: unknown = null;
    try {
      const response = await bucket.download(key);
      data = response.data;
      error = response.error;
    } catch (thrownError) {
      error = thrownError;
    }

    if (!error && data) {
      return data;
    }

    lastError = error ?? new Error("missing download data");
    if (error && !isObjectNotFoundError(error)) {
      throw new Error(`Failed to download bundle: ${getErrorMessage(error)}`);
    }

    const retryDelay = retryDelays[attempt];
    if (retryDelay === undefined) {
      break;
    }
    await delay(retryDelay);
  }

  throw new Error(`Failed to download bundle: ${getErrorMessage(lastError)}`);
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

            await createSignedUrlWithRetry({
              bucket,
              key: Key,
              expiresIn: 3600,
              retryDelays: uploadedObjectSignedUrlRetryDelays,
            });

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

            await createSignedUrlWithRetry({
              bucket,
              key,
              expiresIn: 3600,
              retryDelays: signedUrlRetryDelays,
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

            const data = await downloadWithRetry({
              bucket,
              key,
              retryDelays: signedUrlRetryDelays,
            });

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

            const signedUrl = await createSignedUrlWithRetry({
              bucket,
              key,
              expiresIn: 3600,
              retryDelays: signedUrlRetryDelays,
            });

            return { fileUrl: signedUrl };
          },
        },
      };
    },
  });
