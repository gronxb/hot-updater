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

/**
 * Android native build gradle configuration.
 */
export interface NativeBuildAndroidScheme {
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

  /**
   * Android application package name.
   */
  packageName: string;
}

/**
 * iOS native build configuration.
 */
export interface NativeBuildIosScheme {
  /**
   * The Xcode scheme to build.
   *
   * @example "app"
   */
  scheme: string;

  /**
   * The build configuration to use (e.g., "Debug", "Release").
   *
   * @default "Release"
   */
  buildConfiguration?: "Debug" | "Release";

  /**
   * The SDK to build against (e.g., "iphoneos", "iphonesimulator").
   *
   * @default "iphoneos"
   */
  sdk?: string;

  /**
   * The destination for the build.
   *
   * @default "generic/platform=iOS"
   */
  destination?: string;

  /**
   * Path to a plist file that specifies options for exporting the archive.
   *
   * @example "exportOptions.plist"
   */
  exportOptionsPlist?: string;

  /**
   * Path to an .xcconfig file to include additional build settings.
   */
  xcconfig?: string;

  /**
   * Whether to create an archive for distribution.
   * When true, creates .xcarchive instead of .app bundle.
   *
   * @default false
   */
  archive?: boolean;

  /**
   * Automatically install CocoaPods dependencies before building.
   *
   * @default true
   */
  installPods?: boolean;

  /**
   * Additional parameters passed to xcodebuild.
   *
   * @example ["-quiet", "-allowProvisioningUpdates"]
   */
  extraParams?: string[];

  /**
   * Additional parameters for exportArchive command.
   *
   * @example ["-allowProvisioningUpdates"]
   */
  exportExtraParams?: string[];

  /**
   * Custom build folder (derivedDataPath) for Xcode build artifacts.
   *
   * @example "/tmp/ios-build"
   */
  buildFolder?: string;

  /**
   * Specific target to build within the scheme.
   *
   * @example "MyApp"
   */
  target?: string;

  /**
   * Enable verbose logging for build process.
   *
   * @default false
   */
  verbose?: boolean;
}

export interface NativeBuildArgs {
  /**
   * Android specific configuration schemes.
   */
  android?: Record<string, NativeBuildAndroidScheme>;

  /**
   * iOS specific configuration schemes.
   */
  ios?: Record<string, NativeBuildIosScheme>;
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
