import type { Bundle, Platform } from "@hot-updater/core";

export type { Platform, Bundle } from "@hot-updater/core";

export interface BasePluginArgs {
  cwd: string;
}

export interface BuildPluginArgs extends BasePluginArgs {
  platform: Platform;
}

export interface DatabasePlugin {
  getBundleById: (bundleId: string) => Promise<Bundle | null>;
  getBundles: (refresh?: boolean) => Promise<Bundle[]>;
  updateBundle: (
    targetBundleId: string,
    newBundle: Partial<Bundle>,
  ) => Promise<void>;
  setBundles: (bundles: Bundle[]) => Promise<void>;
  appendBundle: (bundles: Bundle) => Promise<void>;
  commitBundle: () => Promise<void>;

  onUnmount?: () => Promise<void>;
}

export interface DatabasePluginHooks {
  onDatabaseUpdated?: () => Promise<void>;
}

export interface StoragePlugin {
  uploadBundle: (
    bundleId: string,
    bundlePath: string,
  ) => Promise<{
    fileUrl: string;
  }>;

  deleteBundle: (bundleId: string) => Promise<string>;
}

export interface StoragePluginHooks {
  transformFileUrl?: (key: string) => string;
  onStorageUploaded?: () => Promise<void>;
}

export type Config = {
  gitUrl?: string;
  build: (args: BuildPluginArgs) => Promise<{
    buildPath: string;
    bundleId: string;
  }>;
  storage: (args: BasePluginArgs) => StoragePlugin;
  database: (args: BasePluginArgs) => DatabasePlugin;
};
