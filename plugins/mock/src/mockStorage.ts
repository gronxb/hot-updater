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
        Promise.resolve({
          storageUri: `storage://my-app/${bundleId}/bundle.zip`,
        }),
      uploadNativeBuild: (nativeBuildId: string, nativeBuildPath: string) =>
        Promise.resolve({
          storageUri: `storage://my-app/native-builds/${nativeBuildId}/native.apk`,
        }),
      deleteNativeBuild: (nativeBuildId: string) =>
        Promise.resolve({
          storageUri: `storage://my-app/native-builds/${nativeBuildId}/native.apk`,
        }),
      getNativeBuildDownloadUrl: (nativeBuildId: string) =>
        Promise.resolve({
          fileUrl: `https://example.com/native-builds/${nativeBuildId}/download`,
        }),
    };
  };
