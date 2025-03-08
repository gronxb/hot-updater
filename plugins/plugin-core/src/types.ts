import type { Bundle, Platform } from "@hot-updater/core";

export type { Platform, Bundle } from "@hot-updater/core";

export interface BasePluginArgs {
  cwd: string;
}

export interface BuildPluginConfig {
  outDir?: string;
}

export interface DatabasePlugin {
  getBundleById: (bundleId: string) => Promise<Bundle | null>;
  getBundles: (refresh?: boolean) => Promise<Bundle[]>;
  updateBundle: (
    targetBundleId: string,
    newBundle: Partial<Bundle>,
  ) => Promise<void>;
  appendBundle: (bundles: Bundle) => Promise<void>;
  commitBundle: () => Promise<void>;
  onUnmount?: () => Promise<void>;
  name: string;
}

export interface DatabasePluginHooks {
  onDatabaseUpdated?: () => Promise<void>;
}

export interface BuildPlugin {
  build: (args: { platform: Platform }) => Promise<{
    buildPath: string;
    bundleId: string;
    stdout: string | null;
  }>;
  name: string;
}

export interface StoragePlugin {
  uploadBundle: (
    bundleId: string,
    bundlePath: string,
  ) => Promise<{
    fileUrl: string;
  }>;

  deleteBundle: (bundleId: string) => Promise<string>;
  name: string;
}

export interface StoragePluginHooks {
  transformFileUrl?: (key: string) => string;
  onStorageUploaded?: () => Promise<void>;
}

export type Config = {
  console?: {
    /**
     * Git repository URL
     * If git commit hash exists in console, it allows viewing commit history from the git repository
     */
    gitUrl?: string;

    /**
     * Console port
     * @default 1422
     */
    port?: number;
  };
  build: (args: BasePluginArgs) => Promise<BuildPlugin> | BuildPlugin;
  storage: (args: BasePluginArgs) => Promise<StoragePlugin> | StoragePlugin;
  database: (args: BasePluginArgs) => Promise<DatabasePlugin> | DatabasePlugin;
};
