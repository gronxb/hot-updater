import type { BasePluginArgs, StoragePlugin } from "@hot-updater/plugin-core";

export const mockStorage =
  (_: any) =>
  (_: BasePluginArgs): StoragePlugin => {
    return {
      name: "mock",
      supportedProtocol: "mock",
      uploadBundle: (bundleId: string) =>
        Promise.resolve({
          storageUri: `storage://my-app/${bundleId}/bundle.zip`,
        }),
      deleteBundle: (bundleId: string) =>
        Promise.resolve({
          storageUri: `storage://my-app/${bundleId}/bundle.zip`,
        }),
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
