import {
  createStorageKeyBuilder,
  createStorageAdapter,
  createStorageUri,
  parseStorageUri,
  type StorageAdapterWith,
  type StorageObject,
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
/** Keys the binding deletes in one call. */
const DELETE_BATCH_SIZE = 1000;

type R2WorkerOperations =
  | "put"
  | "get"
  | "exists"
  | "delete"
  | "listObjects"
  | "deleteObjects";

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
): StorageAdapterWith<R2WorkerOperations | "getDownloadUrl">;
export function r2WorkerStorage(
  config: CloudflareWorkerStorageConfig,
): StorageAdapterWith<R2WorkerOperations>;
export function r2WorkerStorage(
  config: CloudflareWorkerStorageConfig,
): StorageAdapterWith<R2WorkerOperations> {
  const getStorageKey = createStorageKeyBuilder(config.basePath);
  const basePrefix = getStorageKey() ? `${getStorageKey()}/` : "";

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
    async listObjects(prefix) {
      const folder = getStorageKey(prefix ?? "");
      const objects: StorageObject[] = [];
      let cursor: string | undefined;
      do {
        const listed = await config.bucket.list({
          prefix: folder ? `${folder}/` : "",
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const object of listed.objects) {
          if (!object.key.startsWith(basePrefix)) continue;
          // A key no `put` writes, such as a folder marker, has no URI.
          let storageUri: string;
          try {
            storageUri = createStorageUri({
              protocol: "r2",
              bucket: config.bucketName,
              key: object.key,
            });
          } catch {
            continue;
          }
          objects.push({
            key: object.key.slice(basePrefix.length),
            lastModifiedAt: object.uploaded,
            size: object.size,
            storageUri,
          });
        }
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor !== undefined);
      return objects;
    },
    async deleteObjects(relativeKeys) {
      const keys = relativeKeys.map((key) => getStorageKey(key));
      for (let offset = 0; offset < keys.length; offset += DELETE_BATCH_SIZE) {
        await config.bucket.delete(
          keys.slice(offset, offset + DELETE_BATCH_SIZE),
        );
      }
    },
  });
}
