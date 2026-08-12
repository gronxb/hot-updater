import {
  createStorageDownloadPath,
  createStoragePlugin,
} from "@hot-updater/plugin-core";

export const mockStorage = (_: unknown) =>
  createStoragePlugin({
    name: "mock",
    protocol: "storage",
    async put({ key }) {
      return { storageUri: `storage://my-app/${key}` };
    },
    async get() {
      return { response: null };
    },
    async getDownloadUrl({ storageUri }) {
      return {
        url: createStorageDownloadPath(storageUri, "mock-download"),
      };
    },
    async exists() {
      return { exists: false };
    },
    async delete({ storageUri }) {
      return { storageUri };
    },
  });
