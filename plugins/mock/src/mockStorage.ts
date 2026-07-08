import fs from "node:fs/promises";
import path from "node:path";

import type { StoragePlugin } from "@hot-updater/plugin-core";

export const mockStorage = (_: unknown) => (): StoragePlugin => {
  return {
    name: "mock",
    supportedProtocol: "storage",
    upload: (key: string) =>
      Promise.resolve({
        storageUri: `storage://my-app/${key}/bundle.zip`,
      }),
    exists: (_storageUri: string) => Promise.resolve(false),
    delete: (_storageUri: string) => Promise.resolve(),
    async downloadFile(storageUri: string, filePath: string) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, storageUri);
    },
    async readText() {
      return null;
    },
    async getDownloadUrl(storageUri: string) {
      try {
        const url = new URL(storageUri);
        if (url.protocol === "http:" || url.protocol === "https:") {
          return { fileUrl: storageUri };
        }
      } catch {}
      return {
        fileUrl: `https://example.invalid/download?u=${encodeURIComponent(storageUri)}`,
      };
    },
  };
};
