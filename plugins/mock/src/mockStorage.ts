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
      uploadBundle: (bundleId: string) =>
        Promise.resolve({
          storageUri: `storage://my-app/${bundleId}/bundle.zip`,
        }),
      deleteBundle: (bundleId: string) =>
        Promise.resolve(`storage://my-app/${bundleId}/bundle.zip`),
    };
  };
