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

  /**
   * Android application ID.
   *
   * @default same as packageName
   */
  applicationId?: string;
}

export type IosBuildDestination =
  | { id: string }
  | { name: string }
  | "ios-device"
  | "ios-simulator";
// TODO: support other apple platforms
// | "mac"
// | "mac-catalyst"
// | "visionos-device"
// | "visionos-simulator"
// | "tvos"
// | "tvos-simulator"
// | "watchos"
// | "watchos-simulator";

/**
 * Supported Apple platforms for building and deployment
 */
export const supportedIosPlatforms = {
  ios: "ios",
  // TODO: support other apple platforms
  // macos: "macos",
  // visionos: "visionos",
  // tvos: "tvos",
  // watchos: "watchos",
} as const;

/**
 * Type representing a supported Apple platform
 */
export type ApplePlatform =
  (typeof supportedIosPlatforms)[keyof typeof supportedIosPlatforms];

/**
 * iOS native build configuration.
 */
export interface NativeBuildIosScheme {
  /**
   * The apple platform for build & archive
   *
   * @default ios
   */
  platform?: ApplePlatform;

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
  configuration?: "Debug" | "Release";

  /**
   * The destination for the build.
   *
   * @default "['generic/platform=iOS']"
   */
  destination?: IosBuildDestination[];

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
   * Enable verbose logging for build process.
   *
   * @default false
   */
  verbose?: boolean;
}

export interface PlatformConfig {
  /**
   * Android platform configuration.
   */
  android?: {
    /**
     * Android string resource paths.
     *
     * @default all strings.xml files in the android directory
     * @example ["android/app/src/main/res/values/strings.xml"]
     */
    stringResourcePaths?: string[];
  };

  /**
   * iOS platform configuration.
   */
  ios?: {
    /**
     * iOS info.plist paths.
     *
     * @default all Info.plist files in the ios directory
     * @example ["ios/HotUpdaterExample/Info.plist"]
     */
    infoPlistPaths?: string[];
  };
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
   * @docs https://hot-updater.dev/guide/update-strategy/1_fingerprint
   * If `appVersion`, the bundle will be updated if the target app version is valid.
   * @docs https://hot-updater.dev/guide/update-strategy/2_app-version
   *
   * @default "appVersion"
   */
  updateStrategy: "fingerprint" | "appVersion";
  /**
   * The fingerprint configuration.
   */
  fingerprint?: {
    /**
     * The extra sources to be included in the fingerprint.
     * @example ["resources/**", ".gitignore"]
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
  platform?: PlatformConfig;
  nativeBuild?: NativeBuildArgs;
  build: (args: BasePluginArgs) => Promise<BuildPlugin> | BuildPlugin;
  storage: (args: BasePluginArgs) => Promise<StoragePlugin> | StoragePlugin;
  database: (args: BasePluginArgs) => Promise<DatabasePlugin> | DatabasePlugin;
};

export interface NativeBuildOptions {
  outputPath?: string;
  interactive: boolean;
  message?: string;
  scheme?: string;
}
