import type { Bundle, Platform } from "@hot-updater/utils";

export type { Platform, Bundle } from "@hot-updater/utils";

export interface BasePluginArgs {
  cwd: string;
}

export interface BuildPluginArgs extends BasePluginArgs {
  platform: Platform;
}

export interface DatabasePlugin {
  getBundles: (refresh?: boolean) => Promise<Bundle[]>;
  updateBundle: (
    targetBundleId: string,
    newBundle: Partial<Bundle>,
  ) => Promise<void>;
  setBundles: (bundles: Bundle[]) => Promise<void>;
  appendBundle: (bundles: Bundle) => Promise<void>;
  commitBundle: () => Promise<void>;
}

export interface DatabasePluginHooks {
  onDatabaseUpdated?: () => Promise<void>;
}

export interface StoragePlugin {
  uploadBundle: (
    bundleId: string,
    bundlePath: string,
  ) => Promise<{
    file: string;
  }>;

  deleteBundle: (bundleId: string) => Promise<string>;
}

export interface StoragePluginHooks {
  onStorageUploaded?: () => Promise<void>;
}

export type Config = {
  build: (args: BuildPluginArgs) => Promise<{
    buildPath: string;
    bundleId: string;
  }>;
  storage: (args: BasePluginArgs) => StoragePlugin;
  database: (args: BasePluginArgs) => DatabasePlugin;
};
