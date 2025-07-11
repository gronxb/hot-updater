import type { Bundle, Platform } from "@hot-updater/core";

export type { Platform, Bundle } from "@hot-updater/core";

export * from "./utils";

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
  appendBundle: (insertBundle: Bundle) => Promise<void>;
  commitBundle: () => Promise<void>;
  onUnmount?: () => Promise<void>;
  name: string;
  deleteBundle: (deleteBundle: Bundle) => Promise<void>;
}

export interface DatabasePluginHooks {
  onDatabaseUpdated?: () => Promise<void>;
}

export interface BuildPlugin {
  nativeBuild?: {
    prebuild?: (args: { platform: Platform }) => Promise<void>;
    postbuild?: (args: { platform: Platform }) => Promise<void>;
  };
  build: (args: { platform: Platform }) => Promise<{
    buildPath: string;
    bundleId: string;
    stdout: string | null;
  }>;
  name: string;
}

export interface NativeBuildArgs {
  /**
   * Android specific configuration.
   */
  android?: {
    /**
     * Android application module build variant.
     *
     * @example Debug, Release
     * @default Release
     */
    variant?: string;

    /**
     * Artifact type.
     *
     * If `true`, the generated artifact type is `.aab`.
     * If `flase`, the generated artifact type is `apk`.
     *
     * @default true
     */
    aab?: boolean;

    /**
     * Android application module name.
     *
     * @default app
     */
    appModuleName?: string;
  };
}

export interface StoragePlugin {
  uploadBundle: (
    bundleId: string,
    bundlePath: string,
  ) => Promise<{
    storageUri: string;
  }>;

  deleteBundle: (bundleId: string) => Promise<{
    storageUri: string;
  }>;
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
    /**
     * The extra sources to be included in the fingerprint.
     */
    extraSources?: string[];
    /**
     * The paths to be ignored in the fingerprint.
     */
    ignorePaths?: string[];
    /**
     * When debug mode is enabled, more detailed information will be exposed in fingerprint.json.
     */
    debug?: boolean;
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
  nativeBuild?: NativeBuildArgs;
  build: (args: BasePluginArgs) => Promise<BuildPlugin> | BuildPlugin;
  storage: (args: BasePluginArgs) => Promise<StoragePlugin> | StoragePlugin;
  database: (args: BasePluginArgs) => Promise<DatabasePlugin> | DatabasePlugin;
};
