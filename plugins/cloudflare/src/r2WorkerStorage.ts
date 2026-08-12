import {
  createStorageKeyBuilder,
  createStoragePlugin,
  parseStorageUri,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";

export interface CloudflareWorkerStorageConfig {
  readonly bucket: R2Bucket;
  readonly bucketName: string;
  readonly basePath?: string;
}

export const r2WorkerStorage = (
  config: CloudflareWorkerStorageConfig,
): StoragePluginWith<"put" | "get" | "exists" | "delete"> => {
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

  return createStoragePlugin({
    name: "r2Storage",
    protocol: "r2",
    async put({ key, body, contentType }) {
      const storageKey = getStorageKey(key);
      await config.bucket.put(storageKey, body, {
        httpMetadata: {
          contentType,
          cacheControl: "max-age=31536000",
        },
      });
      return { storageUri: `r2://${config.bucketName}/${storageKey}` };
    },
    async get(storageUri) {
      const { key } = parseAndValidate(storageUri);
      const object = await config.bucket.get(key);
      if (!object) return null;
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("content-length", String(object.size));
      return new Response(object.body, { headers });
    },
    async exists(storageUri) {
      const { key } = parseAndValidate(storageUri);
      return (await config.bucket.head(key)) !== null;
    },
    async delete(storageUri) {
      const { key } = parseAndValidate(storageUri);
      await config.bucket.delete(key);
    },
  });
};
