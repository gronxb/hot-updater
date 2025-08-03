import type {
  BasePluginArgs,
  StoragePlugin,
  StoragePluginHooks,
} from "@hot-updater/plugin-core";

export const mockStorage =
  (_: any, hooks?: StoragePluginHooks) =>
  (_: BasePluginArgs): StoragePlugin => {
    return {
      name: "mock",

      upload: (key: string, filePath: string) => {
        const filename = filePath.split("/").pop() || "file";
        return Promise.resolve({
          storageUri: `storage://my-app/${key}/${filename}`,
        });
      },

      delete: (storageUri: string) => {
        // Mock delete - just resolve without returning anything
        return Promise.resolve();
      },

      getDownloadUrl: (storageUri: string) => {
        // Extract a mock ID from the storageUri for the download URL
        const mockId = storageUri.split("/").slice(-2, -1)[0] || "mock-id";
        return Promise.resolve({
          fileUrl: `https://example.com/download/${mockId}`,
        });
      },
    };
  };
