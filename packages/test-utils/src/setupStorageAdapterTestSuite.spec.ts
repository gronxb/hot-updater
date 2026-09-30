import {
  createStorageAdapter,
  createStorageDownloadUrl,
  createStorageKeyBuilder,
  createStorageUri,
  parseStorageUri,
  type StorageAdapter,
  type StorageAdapterWith,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { setupStorageAdapterTestSuite } from "./setupStorageAdapterTestSuite";
import { storageAdapterTestCases } from "./storageAdapterTestCases";

const PROTOCOL = "memory";

/** The reference adapter: every operation, over a Map. */
const memoryStorage = ({
  bucket = "bundles",
  basePath,
}: { bucket?: string; basePath?: string } = {}) => {
  const objects = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; lastModifiedAt: Date }
  >();
  const objectKey = createStorageKeyBuilder(basePath);
  const root = objectKey();
  const uriOf = (key: string) =>
    createStorageUri({ protocol: PROTOCOL, bucket, key });
  const keyOf = (storageUri: string) => {
    const parsed = parseStorageUri(storageUri, PROTOCOL);
    if (parsed.bucket !== bucket) {
      throw new Error(`Expected bucket "${bucket}", got "${parsed.bucket}".`);
    }
    return parsed.key;
  };
  const signDownload = createStorageDownloadUrl("test-signing-key");

  return createStorageAdapter({
    name: "memoryStorage",
    protocol: PROTOCOL,
    async put({ key, body }) {
      const storedKey = objectKey(key);
      objects.set(storedKey, {
        bytes: new Uint8Array(await new Response(body).arrayBuffer()),
        lastModifiedAt: new Date(),
      });
      return { storageUri: uriOf(storedKey) };
    },
    async get({ storageUri }) {
      const object = objects.get(keyOf(storageUri));
      if (object === undefined) return { response: null };
      return {
        response: new Response(object.bytes.slice(), {
          headers: { "content-length": String(object.bytes.byteLength) },
        }),
      };
    },
    async getDownloadUrl({ storageUri }) {
      keyOf(storageUri);
      return signDownload({ storageUri });
    },
    async exists({ storageUri }) {
      return { exists: objects.has(keyOf(storageUri)) };
    },
    async delete({ storageUri }) {
      objects.delete(keyOf(storageUri));
      return { deleted: true };
    },
    async listObjects(prefix?: string) {
      const folder = objectKey(prefix ?? "");
      return [...objects]
        .filter(([key]) => folder === "" || key.startsWith(`${folder}/`))
        .map(([key, object]) => ({
          key: root === "" ? key : key.slice(root.length + 1),
          storageUri: uriOf(key),
          size: object.bytes.byteLength,
          lastModifiedAt: object.lastModifiedAt,
        }));
    },
    async deleteObjects(keys) {
      for (const key of keys) objects.delete(objectKey(key));
    },
  });
};

type MemoryStorage = ReturnType<typeof memoryStorage>;

setupStorageAdapterTestSuite({
  name: "memory",
  createStorage: async () => ({
    storage: memoryStorage({ basePath: "ota" }),
    basePath: "ota",
  }),
  operations: [
    "put",
    "get",
    "getDownloadUrl",
    "exists",
    "delete",
    "listObjects",
    "deleteObjects",
  ],
});

setupStorageAdapterTestSuite({
  name: "memory at the bucket root",
  createStorage: async () => ({ storage: memoryStorage() }),
});

const runCase = (title: string, storage: StorageAdapter) => {
  const testCase = storageAdapterTestCases.find(
    (candidate) => candidate.title === title,
  );
  if (testCase === undefined) throw new Error(`No case "${title}".`);
  return testCase.run({ storage, basePath: "ota" });
};

const sameBucket = (storageUri: string) =>
  createStorageUri({
    ...parseStorageUri(storageUri, PROTOCOL),
    bucket: "bundles",
  });

/** A reference adapter with one operation replaced. */
const broken = (
  replace: (
    storage: MemoryStorage,
  ) => Partial<StorageAdapterWith<"put" | "get">>,
): StorageAdapter => {
  const storage = memoryStorage({ basePath: "ota" });
  return { ...storage, ...replace(storage) };
};

describe("storage adapter test cases", () => {
  it.each<[string, string, () => StorageAdapter]>([
    [
      "put returns a URI that leaves @ unencoded",
      "returns the canonical URI of each key below the base path",
      () =>
        broken((storage) => ({
          put: async (input) => {
            const { storageUri } = await storage.put(input);
            return { storageUri: storageUri.replaceAll("%40", "@") };
          },
        })),
    ],
    [
      "put returns the URI of the key without the base path",
      "returns the canonical URI of each key below the base path",
      () =>
        broken((storage) => ({
          put: async (input) => {
            await storage.put(input);
            return {
              storageUri: createStorageUri({
                protocol: PROTOCOL,
                bucket: "bundles",
                key: input.key,
              }),
            };
          },
        })),
    ],
    [
      "put stores assets below another folder",
      "reads objects at the URIs deploy derives from a manifest's URI",
      () =>
        broken((storage) => ({
          put: (input) =>
            storage.put(
              input.key.startsWith("assets/")
                ? { ...input, key: `shared/${input.key}` }
                : input,
            ),
        })),
    ],
    [
      "put resolves before it reads the body",
      "stores a streamed body and reads it back",
      () =>
        broken((storage) => ({
          put: async (input) => {
            void storage.put(input);
            return {
              storageUri: createStorageUri({
                protocol: PROTOCOL,
                bucket: "bundles",
                key: `ota/${input.key}`,
              }),
            };
          },
        })),
    ],
    [
      "put keeps a partial object when the body fails",
      "rejects a put whose body fails and keeps no object",
      () =>
        broken((storage) => ({
          put: async (input) => {
            try {
              return await storage.put(input);
            } catch (error) {
              await storage.put({
                ...input,
                body: new Blob(["partial"]).stream(),
              });
              throw error;
            }
          },
        })),
    ],
    [
      "get returns the same response twice",
      "stores a streamed body and reads it back",
      () =>
        broken((storage) => {
          const responses = new Map<string, Response | null>();
          return {
            get: async ({ storageUri }) => {
              if (!responses.has(storageUri)) {
                responses.set(
                  storageUri,
                  (await storage.get({ storageUri })).response,
                );
              }
              return { response: responses.get(storageUri) ?? null };
            },
          };
        }),
    ],
    [
      "get sends another object's content-length",
      "stores a streamed body and reads it back",
      () =>
        broken((storage) => ({
          get: async (input) => {
            const { response } = await storage.get(input);
            if (response === null) return { response };
            return {
              response: new Response(response.body, {
                headers: { "content-length": "1" },
              }),
            };
          },
        })),
    ],
    [
      "get answers a missing object with a 404 response",
      "returns a null response for a missing object",
      () =>
        broken((storage) => ({
          get: async (input) => ({
            response:
              (await storage.get(input)).response ??
              new Response(null, { status: 404 }),
          }),
        })),
    ],
    [
      "exists matches a key it starts",
      "tells whether an object exists",
      () =>
        broken((storage) => ({
          exists: async ({ storageUri }) => ({
            exists: (await storage.listObjects()).some((object) =>
              object.storageUri.startsWith(storageUri),
            ),
          }),
        })),
    ],
    [
      "delete throws for a missing object",
      "deletes exactly one object, and deleting it again succeeds",
      () =>
        broken((storage) => ({
          delete: async (input) => {
            if (!(await storage.exists(input)).exists) {
              throw new Error("No such object.");
            }
            return storage.delete(input);
          },
        })),
    ],
    [
      "delete removes every object whose URI starts with the URI",
      "deletes exactly one object, and deleting it again succeeds",
      () =>
        broken((storage) => ({
          delete: async ({ storageUri }) => {
            for (const object of await storage.listObjects()) {
              if (object.storageUri.startsWith(storageUri)) {
                await storage.delete({ storageUri: object.storageUri });
              }
            }
            return { deleted: true };
          },
        })),
    ],
    [
      "get reads another bucket's URI from this bucket",
      "rejects the URI of an object in another bucket",
      () =>
        broken((storage) => ({
          get: ({ storageUri }) =>
            storage.get({ storageUri: sameBucket(storageUri) }),
        })),
    ],
    [
      "delete removes this bucket's object for another bucket's URI",
      "rejects the URI of an object in another bucket",
      () =>
        broken((storage) => ({
          delete: ({ storageUri }) =>
            storage.delete({ storageUri: sameBucket(storageUri) }),
        })),
    ],
    [
      "exists throws synchronously for another bucket",
      "rejects the URI of an object in another bucket",
      () =>
        broken((storage) => ({
          exists: (input) => {
            if (!input.storageUri.startsWith(`${PROTOCOL}://bundles/`)) {
              throw new Error("Another bucket.");
            }
            return storage.exists(input);
          },
        })),
    ],
    [
      "get accepts any protocol",
      "rejects the URI of another protocol",
      () =>
        broken((storage) => ({
          get: ({ storageUri }) =>
            storage.get({
              storageUri: storageUri.replace(/^[^:]+:/, `${PROTOCOL}:`),
            }),
        })),
    ],
    [
      "getDownloadUrl returns the storage URI",
      "resolves a download URL for a stored object",
      () =>
        broken(() => ({
          getDownloadUrl: async ({ storageUri }) => ({ url: storageUri }),
        })),
    ],
    [
      "getDownloadUrl signs each call differently",
      "resolves a download URL for a stored object",
      () =>
        broken(() => ({
          getDownloadUrl: (input) =>
            createStorageDownloadUrl(crypto.randomUUID())(input),
        })),
    ],
    [
      "listObjects returns keys with the base path",
      "lists every object with its key relative to the base path",
      () =>
        broken((storage) => ({
          listObjects: async (prefix) =>
            (await storage.listObjects(prefix)).map((object) => ({
              ...object,
              key: `ota/${object.key}`,
            })),
        })),
    ],
    [
      "listObjects returns URIs with unencoded keys",
      "lists every object with its key relative to the base path",
      () =>
        broken((storage) => ({
          listObjects: async (prefix) =>
            (await storage.listObjects(prefix)).map((object) => ({
              ...object,
              storageUri: `${PROTOCOL}://bundles/ota/${object.key}`,
            })),
        })),
    ],
    [
      "listObjects matches a prefix as a string, not a folder",
      "lists every object with its key relative to the base path",
      () =>
        broken((storage) => ({
          listObjects: async (prefix) =>
            (await storage.listObjects()).filter((object) =>
              object.key.startsWith(prefix ?? ""),
            ),
        })),
    ],
    [
      "listObjects reports modification times in seconds",
      "lists every object with its key relative to the base path",
      () =>
        broken((storage) => ({
          listObjects: async (prefix) =>
            (await storage.listObjects(prefix)).map((object) => ({
              ...object,
              lastModifiedAt: new Date(
                (object.lastModifiedAt?.getTime() ?? 0) / 1000,
              ),
            })),
        })),
    ],
    [
      "deleteObjects removes a folder's objects",
      "deletes exactly the keys it receives",
      () =>
        broken((storage) => ({
          deleteObjects: async (keys) => {
            const objects = await storage.listObjects();
            await storage.deleteObjects(
              objects
                .filter((object) =>
                  keys.some(
                    (key) =>
                      object.key === key || object.key.startsWith(`${key}/`),
                  ),
                )
                .map((object) => object.key),
            );
          },
        })),
    ],
  ])("fail when %s", async (_defect, title, create) => {
    await expect(runCase(title, create())).rejects.toThrow();
  });
});
