import {
  createStorageKeyBuilder,
  createStorageAdapter,
  createStorageUri,
  parseStorageUri,
  type StorageAdapterWith,
} from "@hot-updater/plugin-core";

import { presignR2GetUrl, type R2Credentials } from "./presignR2Url";

export type CloudflareWorkerStorageConfig = {
  readonly bucket: R2Bucket;
  readonly bucketName: string;
  readonly basePath?: string;
} & (
  | {
      /** The account whose R2 endpoint download URLs name. */
      readonly accountId: string;
      /**
       * R2's S3-compatible credentials, which presign download URLs, as
       * `r2Storage` from `@hot-updater/cloudflare` does: what a server needs
       * to serve downloads.
       */
      readonly credentials: R2Credentials;
    }
  | { readonly accountId?: undefined; readonly credentials?: undefined }
);

/** Devices download right after the update check that returns the URL. */
const PRESIGNED_URL_EXPIRES_IN_SECONDS = 3600;

/**
 * Storage on the Worker's R2 binding. With R2's S3-compatible credentials,
 * its download URLs are presigned and devices download from the bucket;
 * without them, it has no `getDownloadUrl`, as a Console that only reads
 * needs.
 */
export function r2WorkerStorage(
  config: CloudflareWorkerStorageConfig & {
    readonly credentials: R2Credentials;
  },
): StorageAdapterWith<"put" | "get" | "getDownloadUrl" | "exists" | "delete">;
export function r2WorkerStorage(
  config: CloudflareWorkerStorageConfig,
): StorageAdapterWith<"put" | "get" | "exists" | "delete">;
export function r2WorkerStorage(
  config: CloudflareWorkerStorageConfig,
): StorageAdapterWith<"put" | "get" | "exists" | "delete"> {
  const getStorageKey = createStorageKeyBuilder(config.basePath);

  const parseAndValidate = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, "r2");
    if (parsed.bucket !== config.bucketName) {
      throw new Error(
        `Bucket name mismatch: expected "${config.bucketName}", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  return createStorageAdapter({
    name: "r2Storage",
    protocol: "r2",
    async put({ key, body, contentLength, contentType }) {
      const storageKey = getStorageKey(key);
      const uploadOptions = {
        httpMetadata: {
          contentType,
          cacheControl: "max-age=31536000",
        },
      };
      if (contentLength === undefined) {
        const bufferedBody = new Uint8Array(
          await new Response(body).arrayBuffer(),
        );
        await config.bucket.put(storageKey, bufferedBody, uploadOptions);
      } else {
        const fixedLengthBody = new FixedLengthStream(contentLength);
        await Promise.all([
          body.pipeTo(fixedLengthBody.writable),
          config.bucket.put(
            storageKey,
            fixedLengthBody.readable,
            uploadOptions,
          ),
        ]);
      }
      return {
        storageUri: createStorageUri({
          protocol: "r2",
          bucket: config.bucketName,
          key: storageKey,
        }),
      };
    },
    async get({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      const object = await config.bucket.get(key);
      if (!object) return { response: null };
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("content-length", String(object.size));
      return { response: new Response(object.body, { headers }) };
    },
    ...(config.credentials === undefined
      ? {}
      : {
          async getDownloadUrl({ storageUri }: { storageUri: string }) {
            const { key } = parseAndValidate(storageUri);
            return {
              url: await presignR2GetUrl({
                accountId: config.accountId,
                bucketName: config.bucketName,
                credentials: config.credentials,
                expiresInSeconds: PRESIGNED_URL_EXPIRES_IN_SECONDS,
                key,
              }),
            };
          },
        }),
    async exists({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      return { exists: (await config.bucket.head(key)) !== null };
    },
    async delete({ storageUri }) {
      const { key } = parseAndValidate(storageUri);
      await config.bucket.delete(key);
      return { deleted: true };
    },
  });
}
