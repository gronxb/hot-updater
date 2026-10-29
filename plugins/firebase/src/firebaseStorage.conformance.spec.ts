import { Writable } from "node:stream";

import { setupStorageAdapterTestSuite } from "@hot-updater/test-utils";
import { vi } from "vitest";

import { firebaseStorage } from "./firebaseStorage";

/**
 * A Cloud Storage bucket behind the firebase-admin calls the adapter makes.
 * A missing object fails the way the SDK does, with code 404.
 */
const { getStorage, objects } = vi.hoisted(() => {
  const objects = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; contentType?: string; updated: string }
  >();
  const notFound = () =>
    Object.assign(new Error("No such object"), { code: 404 });
  const file = (key: string) => ({
    // The object exists once the upload ends, as a Cloud Storage upload does.
    createWriteStream(options: { metadata: { contentType?: string } }) {
      const chunks: Uint8Array[] = [];
      return new Writable({
        write(chunk: Uint8Array, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
        final(callback) {
          objects.set(key, {
            bytes: new Uint8Array(Buffer.concat(chunks)),
            contentType: options.metadata.contentType,
            updated: new Date().toISOString(),
          });
          callback();
        },
      });
    },
    async download() {
      const object = objects.get(key);
      if (object === undefined) throw notFound();
      return [Buffer.from(object.bytes)];
    },
    async getMetadata() {
      const object = objects.get(key);
      if (object === undefined) throw notFound();
      return [
        {
          contentType: object.contentType,
          size: String(object.bytes.byteLength),
        },
      ];
    },
    async exists() {
      return [objects.has(key)];
    },
    async delete({ ignoreNotFound }: { ignoreNotFound?: boolean } = {}) {
      if (!objects.delete(key) && !ignoreNotFound) throw notFound();
    },
    async getSignedUrl() {
      return [
        `https://storage.googleapis.com/updates/${encodeURI(key)}?X-Goog-Signature=test`,
      ];
    },
  });
  /** Every object whose name starts with `prefix`, with its metadata. */
  const getFiles = async ({ prefix = "" }: { prefix?: string }) => [
    [...objects]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, object]) => ({
        name,
        metadata: {
          size: String(object.bytes.byteLength),
          updated: object.updated,
        },
      })),
  ];
  return {
    getStorage: () => ({ bucket: () => ({ file, getFiles }) }),
    objects,
  };
});

vi.mock("firebase-admin/app", () => ({
  getApp: () => ({}),
  getApps: () => [{}],
  initializeApp: () => ({}),
}));
vi.mock("firebase-admin/storage", () => ({ getStorage }));

setupStorageAdapterTestSuite({
  name: "firebaseStorage",
  createStorage: async () => {
    objects.clear();
    return {
      storage: firebaseStorage({
        basePath: "ota",
        projectId: "project",
        storageBucket: "updates",
      }),
      basePath: "ota",
    };
  },
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
