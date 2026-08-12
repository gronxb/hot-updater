import { createStoragePlugin } from "@hot-updater/plugin-core";

export const mockStorage = (_: unknown) =>
  createStoragePlugin({
    name: "mock",
    protocol: "storage",
    async put({ key }) {
      return { storageUri: `storage://my-app/${key}` };
    },
    async get() {
      return null;
    },
    async exists() {
      return false;
    },
    async delete() {},
  });
