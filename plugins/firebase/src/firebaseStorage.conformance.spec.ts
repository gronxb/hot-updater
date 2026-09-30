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
    { bytes: Uint8Array<ArrayBuffer>; contentType?: string }
  >();
  const notFound = () =>
    Object.assign(new Error("No such object"), { code: 404 });
  const file = (key: string) => ({
    async save(
      bytes: Uint8Array<ArrayBuffer>,
      options: { metadata: { contentType?: string } },
    ) {
      objects.set(key, {
        bytes: bytes.slice(),
        contentType: options.metadata.contentType,
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
  return {
    getStorage: () => ({ bucket: () => ({ file }) }),
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
  operations: ["put", "get", "getDownloadUrl", "exists", "delete"],
});
