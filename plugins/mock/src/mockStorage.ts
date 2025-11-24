import type { StoragePlugin } from "@hot-updater/plugin-core";

export const mockStorage = (_: any) => (): StoragePlugin => {
  return {
    name: "mock",
    supportedProtocol: "storage",
    upload: (key: string) =>
      Promise.resolve({
        storageUri: `storage://my-app/${key}/bundle.zip`,
      }),
    delete: (_storageUri: string) => Promise.resolve(),
    async getDownloadUrl(storageUri: string) {
      try {
        const url = new URL(storageUri);
        if (url.protocol === "http:" || url.protocol === "https:") {
          return { fileUrl: storageUri };
        }
      } catch {}
      // For mock, return a deterministic fake URL for testing
      return {
        fileUrl: `https://example.invalid/download?u=${encodeURIComponent(storageUri)}`,
      };
    },
  };
};
