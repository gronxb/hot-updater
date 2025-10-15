import type { BasePluginArgs, StoragePlugin } from "@hot-updater/plugin-core";

export const mockStorage =
  (_: any) =>
  (_: BasePluginArgs): StoragePlugin => {
    return {
      name: "mock",
      uploadBundle: (bundleId: string, _bundlePath: string, _metadata?) =>
        Promise.resolve({
          storageUri: `storage://my-app/${bundleId}/bundle.zip`,
        }),
      deleteBundle: (bundleId: string) =>
        Promise.resolve({
          storageUri: `storage://my-app/${bundleId}/bundle.zip`,
        }),
    };
  };
