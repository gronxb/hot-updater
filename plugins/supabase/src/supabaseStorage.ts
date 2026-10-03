import {
  createStorageAdapter,
  createStorageKeyBuilder,
  createStorageUri,
  parseStorageUri,
  type StorageAdapterWith,
} from "@hot-updater/plugin-core";
import { createClient } from "@supabase/supabase-js";

import {
  resolveSupabaseServiceRoleKey,
  type SupabaseServiceRoleConfig,
} from "./supabaseConfig";
import { createSupabaseSignedUrlBatcher } from "./supabaseSignedUrlBatcher";

const isNotFoundError = (error: { message?: string } | null | undefined) =>
  error?.message?.toLowerCase().includes("not found") === true;

/**
 * Storage's unread response to a download or HEAD request it failed, which
 * supabase-js wraps in a StorageUnknownError.
 */
const failedResponseOf = (error: unknown) => {
  if (
    typeof error !== "object" ||
    error === null ||
    Reflect.get(error, "name") !== "StorageUnknownError"
  ) {
    return undefined;
  }

  const response: unknown = Reflect.get(error, "originalError");
  if (
    typeof response !== "object" ||
    response === null ||
    typeof Reflect.get(response, "status") !== "number"
  ) {
    return undefined;
  }
  return response as Pick<Response, "status" | "json">;
};

/** Storage answers a HEAD request for a missing object with 400 or 404. */
const isMissingExistsError = (error: unknown) => {
  const status = failedResponseOf(error)?.status;
  return status === 400 || status === 404;
};

/**
 * Storage answers a download of a missing object with 400 or 404 and
 * `error: "not_found"`, and a missing bucket with another error.
 */
const isMissingObjectError = async (error: unknown) => {
  const response = failedResponseOf(error);
  if (response?.status !== 400 && response?.status !== 404) return false;
  const body: unknown = await response.json().catch(() => undefined);
  return (
    typeof body === "object" &&
    body !== null &&
    Reflect.get(body, "error") === "not_found"
  );
};

/** A character Storage rejects in an object name, `?`, or `!`. */
const ESCAPED_CHARACTER = /[^A-Za-z0-9_/.*'() &$=@;:+,-]/gu;
const utf8 = new TextEncoder();

/**
 * The object name Storage keeps a key under. Storage accepts names of ASCII
 * letters, digits and `_/!.*'() &$=@;:+,?-` only, and supabase-js puts a name
 * in the request URL unencoded, where `?` ends the path. So every other
 * character of the key, `?`, and the escape character `!` are stored as `!`
 * and the two hex digits of each of their UTF-8 bytes, such as `#` as `!23`.
 * Distinct keys keep distinct names, and the names need no URL encoding.
 * Deploy's keys, such as `<bundleId>/manifest.json`, are stored as they are.
 */
const toObjectName = (key: string) =>
  key.replace(ESCAPED_CHARACTER, (character) =>
    Array.from(
      utf8.encode(character),
      (byte) => `!${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    ).join(""),
  );

export type SupabaseStorageConfig = SupabaseServiceRoleConfig & {
  bucketName: string;
  /** Base path where bundles will be stored in the bucket. */
  basePath?: string;
  /** Signed download URL lifetime in seconds. @default 3600 */
  signedUrlExpiresIn?: number;
};

export const supabaseStorage = (
  config: SupabaseStorageConfig,
): StorageAdapterWith<
  "put" | "get" | "getDownloadUrl" | "exists" | "delete"
> => {
  const supabase = createClient(
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

  return createStorageAdapter({
    name: "supabaseStorage",
    protocol: "supabase-storage",
    async put({ key, body, contentLength, contentType }) {
      const storageKey = getStorageKey(key);
      const { error } = await bucket.upload(toObjectName(storageKey), body, {
        contentType,
        cacheControl: "max-age=31536000",
        upsert: true,
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
      const { data, error } = await bucket.download(toObjectName(key));
      if (error) {
        if (await isMissingObjectError(error)) return { response: null };
        throw new Error(`Failed to download storage object: ${error.message}`);
      }
      return { response: data ? new Response(data) : null };
    },
    async getDownloadUrl({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      return {
        url: await resolveSignedUrl(config.bucketName, toObjectName(key)),
      };
    },
    async exists({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      const { data, error } = await bucket.exists(toObjectName(key));
      if (error) {
        if (isMissingExistsError(error)) return { exists: false };
        throw error;
      }
      return { exists: data };
    },
    async delete({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      const { error } = await bucket.remove([toObjectName(key)]);
      if (error && !isNotFoundError(error)) {
        throw new Error(`Failed to delete storage object: ${error.message}`);
      }
      return { deleted: true };
    },
  });
};
