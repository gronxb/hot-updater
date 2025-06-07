import type { Bundle, Platform } from "@hot-updater/core";

export type { Platform, Bundle } from "@hot-updater/core";

export interface BasePluginArgs {
  cwd: string;
}

export interface PaginationInfo {
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  currentPage: number;
  totalPages: number;
}

export interface BuildPluginConfig {
  outDir?: string;
}

export interface DatabasePlugin {
  getChannels: () => Promise<string[]>;
  getBundleById: (bundleId: string) => Promise<Bundle | null>;
  getBundles: (options: {
    where?: { channel?: string; platform?: string };
    limit: number;
    offset: number;
  }) => Promise<{
    data: Bundle[];
    pagination: PaginationInfo;
  }>;
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
    storageUri: string;
  }>;

  deleteBundle: (bundleId: string) => Promise<string>;
  name: string;
}

export interface StoragePluginHooks {
  onStorageUploaded?: () => Promise<void>;
}

export type ConfigInput = {
  /**
   * The channel used when building the native app.
   * Used to replace __HOT_UPDATER_CHANNEL at build time.
   *
   * @deprecated Use the `hot-updater channel create` command to create a channel.
   */
  releaseChannel?: string;
  /**
   * The strategy used to update the app.
   *
   * If `fingerprint`, the bundle will be updated if the fingerprint of the app is changed.
   * If `app-version`, the bundle will be updated if the target app version is valid.
   *
   * @default "fingerprint"
   */
  updateStrategy?: "fingerprint" | "appVersion";
  /**
   * The fingerprint configuration.
   */
  fingerprint?: {
    extraSources?: string[];
    ignorePaths?: string[];
  };
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
