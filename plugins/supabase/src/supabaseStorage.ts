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
import { createSupabaseSignedUrlBatcher } from "./supabaseSignedUrlBatcher";
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

const parseSupabaseStorageUri = (storageUri: string) => {
  return parseStorageUri(storageUri, "supabase-storage");
};

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
      const resolveSignedUrl = createSupabaseSignedUrlBatcher({
        createSignedUrls: (_bucketName, keys, expiresIn) =>
          bucket.createSignedUrls(keys, expiresIn),
        expiresIn: 3600,
        formatObjectPath: (_bucketName, key) => key,
      });

      return {
        node: {
          async delete(storageUri) {
            const { key, bucket: bucketName } =
              parseSupabaseStorageUri(storageUri);
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

            const fullPath = upload.data.fullPath;

            return {
              storageUri: `supabase-storage://${fullPath}`,
            };
          },
          async exists(storageUri: string) {
            const { key, bucket: bucketName } =
              parseSupabaseStorageUri(storageUri);
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
            const { key, bucket: bucketName } =
              parseSupabaseStorageUri(storageUri);
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
            const { key, bucket: bucketName } =
              parseSupabaseStorageUri(storageUri);
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
            const { bucket: bucketName, key } =
              parseSupabaseStorageUri(storageUri);
            if (bucketName !== config.bucketName) {
              throw new Error(
                `Bucket name mismatch: expected "${config.bucketName}", but found "${bucketName}".`,
              );
            }

            const signedUrl = await resolveSignedUrl(config.bucketName, key);

            return { fileUrl: signedUrl };
          },
        },
      };
    },
  });
