import {
  createStorageDownloadPath,
  createStoragePlugin,
  createStorageUri,
  parseStorageUri,
  type StoragePluginWith,
} from "@hot-updater/plugin-core";

interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export const mockStorage = (
  _: unknown,
): StoragePluginWith<
  "put" | "get" | "getDownloadUrl" | "exists" | "delete"
> => {
  const objects = new Map<string, StoredObject>();

  const parseAndValidate = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, "storage");
    if (parsed.bucket !== "my-app") {
      throw new Error(
        `Bucket name mismatch: expected "my-app", but found "${parsed.bucket}".`,
      );
    }
    return parsed;
  };

  return createStoragePlugin({
    name: "mock",
    protocol: "storage",
    async put({ key, body, contentType }) {
      const storageUri = createStorageUri({
        bucket: "my-app",
        key,
        protocol: "storage",
      });
      objects.set(storageUri, {
        body: new Uint8Array(await new Response(body).arrayBuffer()),
        contentType,
      });
      return { storageUri };
    },
    async get({ storageUri }) {
      parseAndValidate(storageUri);
      const object = objects.get(storageUri);
      if (!object) return { response: null };
      return {
        response: new Response(object.body.slice(), {
          headers: {
            "content-length": String(object.body.byteLength),
            "content-type": object.contentType,
          },
        }),
      };
    },
    async getDownloadUrl({ storageUri }) {
      parseAndValidate(storageUri);
      return {
        url: createStorageDownloadPath(storageUri, "mock-download"),
      };
    },
    async exists({ storageUri }) {
      parseAndValidate(storageUri);
      return { exists: objects.has(storageUri) };
    },
    async delete({ storageUri }) {
      parseAndValidate(storageUri);
      objects.delete(storageUri);
      return { deleted: true };
    },
  });
};
