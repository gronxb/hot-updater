import {
  createStorageKeyBuilder,
  createStorageDownloadUrl,
  createStoragePlugin,
  createStorageUri,
  parseStorageUri,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";

export interface CloudflareWorkerStorageConfig {
  readonly bucket: R2Bucket;
  readonly bucketName: string;
  readonly basePath?: string;
  readonly downloadUrlSigningKey: string;
}

export const r2WorkerStorage = (
  config: CloudflareWorkerStorageConfig,
): StoragePluginWith<
  "put" | "get" | "getDownloadUrl" | "exists" | "delete"
> => {
  const getStorageKey = createStorageKeyBuilder(config.basePath);
  const getDownloadUrl = createStorageDownloadUrl(config.downloadUrlSigningKey);

  const parseAndValidate = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, "r2");
    if (parsed.bucket !== config.bucketName) {
      throw new Error(
        `Bucket name mismatch: expected "${config.bucketName}", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  return createStoragePlugin({
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
    async getDownloadUrl({ storageUri }) {
      parseAndValidate(storageUri);
      return getDownloadUrl({ storageUri });
    },
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
};
