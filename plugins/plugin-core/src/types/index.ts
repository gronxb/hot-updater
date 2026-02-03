import type { Bundle, Platform } from "@hot-updater/core";

export type { Bundle, Platform } from "@hot-updater/core";

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
   * The bundle identifier of the app.
   */
  bundleIdentifier: string;
  /**
   * Apple platform for build & archive
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
  configuration?: "Debug" | "Release" | string;

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
   * Automatically install CocoaPods dependencies before building.
   *
   * @default false
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
  /**
   * Protocol this storage plugin can resolve.
   * @example "s3", "r2", "supabase-storage".
   */
  supportedProtocol: string;

  upload: (
    key: string,
    filePath: string,
  ) => Promise<{
    storageUri: string;
  }>;

  delete: (storageUri: string) => Promise<void>;

  getDownloadUrl: (storageUri: string) => Promise<{
    fileUrl: string;
  }>;
  name: string;
}

export interface StoragePluginHooks {
  onStorageUploaded?: () => Promise<void>;
}

/**
 * Signing configuration type with conditional required fields.
 * When enabled is true, privateKeyPath is required.
 * When enabled is false, privateKeyPath is optional.
 */
export type SigningConfig =
  | {
      /**
       * Enable bundle signing during deployment.
       * When false, signing is disabled and privateKeyPath is optional.
       */
      enabled: false;
      /**
       * Path to RSA private key file in PEM format (PKCS#8).
       * Optional when signing is disabled.
       */
      privateKeyPath?: string;
    }
  | {
      /**
       * Enable bundle signing during deployment.
       * When true, bundles will be signed with privateKeyPath.
       */
      enabled: true;
      /**
       * Path to RSA private key file in PEM format (PKCS#8).
       * Generate with: npx hot-updater keys:generate
       *
       * Security: Never commit this key to version control!
       * Use secure storage (AWS Secrets Manager, etc.) for CI/CD.
       *
       * @example "./keys/private-key.pem"
       * @example "/secure/path/to/private-key.pem"
       */
      privateKeyPath: string;
    };

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
   * @docs https://hot-updater.dev/docs/guides/update-strategies/fingerprint
   * If `appVersion`, the bundle will be updated if the target app version is valid.
   * @docs https://hot-updater.dev/docs/guides/update-strategies/app-version
   *
   * @default "appVersion"
   */
  updateStrategy: "fingerprint" | "appVersion";
  /**
   * The compression strategy used for bundle deployment.
   *
   * - `zip`: Standard ZIP compression (default). Fast and widely supported.
   * - `tar.br`: TAR archive with Brotli compression. Highest compression ratio, smaller bundle size.
   * - `tar.gz`: TAR archive with Gzip compression. Balanced speed and compression ratio.
   *
   * The compression format is determined by the storage plugin used for bundle upload.
   *
   * @default "zip"
   */
  compressStrategy?: "zip" | "tar.br" | "tar.gz";
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
  /**
   * Code signing configuration for bundle verification.
   * Enables RSA-SHA256 cryptographic signatures for bundle integrity.
   *
   * @optional Feature is opt-in for backward compatibility
   *
   * @example
   * ```ts
   * // Signing enabled - privateKeyPath is required
   * signing: {
   *   enabled: true,
   *   privateKeyPath: './keys/private-key.pem'
   * }
   *
   * // Signing disabled - privateKeyPath is optional
   * signing: {
   *   enabled: false
   * }
   * ```
   */
  signing?: SigningConfig;
  build: (args: BasePluginArgs) => Promise<BuildPlugin> | BuildPlugin;
  storage: () => Promise<StoragePlugin> | StoragePlugin;
  database: () => Promise<DatabasePlugin> | DatabasePlugin;
};

export interface NativeBuildOptions {
  outputPath?: string;
  interactive: boolean;
  message?: string;
  scheme?: string;
}
