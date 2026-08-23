import {
  createStorageKeyBuilder,
  createStoragePlugin,
  createStorageUri,
  parseStorageUri,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";

import {
  resolveSupabaseServiceRoleKey,
  type SupabaseServiceRoleConfig,
} from "./supabaseConfig";
import { createSupabaseSignedUrlBatcher } from "./supabaseSignedUrlBatcher";
import type { Database } from "./types";

const isNotFoundError = (error: { message?: string } | null | undefined) =>
  error?.message?.toLowerCase().includes("not found") === true;

const isMissingExistsError = (error: unknown) => {
  if (
    typeof error !== "object" ||
    error === null ||
    Reflect.get(error, "name") !== "StorageUnknownError"
  ) {
    return false;
  }

  const originalError = Reflect.get(error, "originalError");
  if (typeof originalError !== "object" || originalError === null) {
    return false;
  }

  const status = Reflect.get(originalError, "status");
  return status === 400 || status === 404;
};

export type SupabaseStorageConfig = SupabaseServiceRoleConfig & {
  bucketName: string;
  /** Base path where bundles will be stored in the bucket. */
  basePath?: string;
  /** Signed download URL lifetime in seconds. @default 3600 */
  signedUrlExpiresIn?: number;
};

export const supabaseStorage = (
  config: SupabaseStorageConfig,
): StoragePluginWith<
  "put" | "get" | "getDownloadUrl" | "exists" | "delete"
> => {
  const supabase = createClient<Database>(
    config.supabaseUrl,
    resolveSupabaseServiceRoleKey(config),
  );
  const bucket = supabase.storage.from(config.bucketName);
  const getStorageKey = createStorageKeyBuilder(config.basePath);
  const resolveSignedUrl = createSupabaseSignedUrlBatcher({
    createSignedUrls: (_bucketName, keys, expiresIn) =>
      bucket.createSignedUrls(keys, expiresIn),
    expiresIn: config.signedUrlExpiresIn ?? 3600,
    formatObjectPath: (_bucketName, key) => key,
  });

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
    async put({ key, body, contentLength, contentType }) {
      const storageKey = getStorageKey(key);
      const { error } = await bucket.upload(storageKey, body, {
        contentType,
        cacheControl: "max-age=31536000",
        duplex: "half",
        ...(contentLength === undefined
          ? {}
          : { headers: { "content-length": String(contentLength) } }),
      });
      if (error) throw error;
      return {
        storageUri: createStorageUri({
          protocol: "supabase-storage",
          bucket: config.bucketName,
          key: storageKey,
        }),
      };
    },
    async get({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      const { data, error } = await bucket.download(key);
      if (error) {
        if (isNotFoundError(error)) return { response: null };
        throw new Error(`Failed to download storage object: ${error.message}`);
      }
      return { response: data ? new Response(data) : null };
    },
    async getDownloadUrl({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      return { url: await resolveSignedUrl(config.bucketName, key) };
    },
    async exists({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      const { data, error } = await bucket.exists(key);
      if (error) {
        if (isMissingExistsError(error)) return { exists: false };
        throw error;
      }
      return { exists: data };
    },
    async delete({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      const { error } = await bucket.remove([key]);
      if (error && !isNotFoundError(error)) {
        throw new Error(`Failed to delete storage object: ${error.message}`);
      }
      return { deleted: true };
    },
  });
};
