import type { Bundle, Platform } from "@hot-updater/core";

export type { Bundle, Platform } from "@hot-updater/core";

export * from "./utils";
export * from "./public";

export interface BasePluginArgs {
  cwd: string;
}

export interface PaginationInfo {
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  currentPage: number;
  totalPages: number;
  nextCursor?: string | null;
  previousCursor?: string | null;
}

export interface Paginated<TData> {
  data: TData;
  pagination: PaginationInfo;
}

export type PaginatedResult = Paginated<Bundle[]>;

export interface DatabaseBundleIdFilter {
  eq?: string;
  gt?: string;
  gte?: string;
  lt?: string;
  lte?: string;
  in?: string[];
}

export interface DatabaseBundleQueryWhere {
  platform?: Platform;
  id?: DatabaseBundleIdFilter;
}

export interface DatabaseBundleQueryOrder {
  field: "id";
  direction: "asc" | "desc";
}

export type DatabaseBundleCursor =
  | {
      /**
       * Fetch the next window after this bundle ID.
       *
       * This is the preferred pagination mode for bundle-management queries.
       */
      after: string;
      before?: never;
    }
  | {
      after?: never;
      /**
       * Fetch the previous window before this bundle ID.
       *
       * This is the preferred pagination mode for bundle-management queries.
       */
      before: string;
    };

type DatabaseBundlePaginationOptions =
  | {
      /**
       * Optional page number used by management UIs to keep page boundaries
       * stable even when new bundles are inserted ahead of the current cursor
       * window.
       */
      page?: number;
      cursor?: never;
    }
  | {
      page?: never;
      /**
       * Preferred cursor-based pagination for bundle-management queries.
       */
      cursor?: DatabaseBundleCursor;
    };

export type DatabaseBundleQueryOptions = {
  where?: DatabaseBundleQueryWhere;
  limit: number;
  orderBy?: DatabaseBundleQueryOrder;
} & DatabaseBundlePaginationOptions;

export interface BuildPluginConfig {
  outDir?: string;
}

export interface BuildPlugin {
  nativeBuild?: {
    /** Resolves the public key embedded by the native build configuration. */
    getBundleSigningPublicKey?: () => Promise<{
      readonly publicKey: string;
    } | null>;
    /** Resolves native configuration files that must affect the fingerprint. */
    getFingerprintExtraSources?: () => Promise<readonly string[]>;
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

  /**
   * Convenience shortcut option for simulator builds.
   * When true, this option should not be used together with the destination option.
   *
   * This option only affects build:ios, not run:ios.
   *
   * @default false
   */
  simulator?: boolean;
}

export interface PlatformConfig {
  /**
   * Android platform configuration.
   */
  android?: {
    /**
     * Android manifest paths.
     *
     * @default all AndroidManifest.xml files in the android directory
     * @example ["android/app/src/main/AndroidManifest.xml"]
     */
    androidManifestPaths?: string[];
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

export interface StoragePutInput {
  /** Complete object key below the provider's configured base path. */
  readonly key: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly contentLength?: number;
  readonly contentType: string;
}

export interface StoragePutResult {
  readonly storageUri: string;
}

export interface StorageGetInput {
  readonly storageUri: string;
}

export interface StorageGetResult {
  readonly response: Response | null;
}

export interface StorageExistsInput {
  readonly storageUri: string;
}

export interface StorageExistsResult {
  readonly exists: boolean;
}

export interface StorageDeleteInput {
  readonly storageUri: string;
}

export interface StorageDeleteResult {
  readonly deleted: true;
}

export interface StorageObject {
  /** Object key relative to the storage plugin's configured base path. */
  readonly key: string;
  readonly storageUri: string;
  readonly size: number;
  readonly lastModifiedAt?: Date;
}

export interface StorageGetDownloadUrlInput {
  readonly storageUri: string;
}

export interface StorageGetDownloadUrlResult {
  readonly url: string;
}

/**
 * Runtime-independent object storage contract.
 *
 * `storageUri` values are hierarchical identifiers in the form
 * `protocol://bucket/slash-separated-encoded-key`.
 *
 * SDK clients, platform bindings, credentials, and local file I/O belong to
 * provider implementations and consumers, never to this interface.
 */
export interface StoragePlugin {
  readonly name: string;
  /**
   * Protocol this plugin resolves and stores in database storage URIs.
   * @example "s3", "r2", "supabase-storage".
   */
  readonly protocol: string;
  readonly put?: (input: StoragePutInput) => Promise<StoragePutResult>;
  readonly get?: (input: StorageGetInput) => Promise<StorageGetResult>;
  /** Resolves the URL an update client uses to download the object. */
  readonly getDownloadUrl?: (
    input: StorageGetDownloadUrlInput,
  ) => Promise<StorageGetDownloadUrlResult>;
  /**
   * Returns true when an object can be safely reused by deploy. Providers may
   * validate more than physical existence when download readiness is required.
   */
  readonly exists?: (input: StorageExistsInput) => Promise<StorageExistsResult>;
  /** Deletes exactly the object referenced by `storageUri`. */
  readonly delete?: (input: StorageDeleteInput) => Promise<StorageDeleteResult>;
  /** Lists objects below the optional base-path-relative prefix. */
  readonly listObjects?: (prefix?: string) => Promise<StorageObject[]>;
  /** Deletes only the exact base-path-relative keys supplied by the caller. */
  readonly deleteObjects?: (keys: readonly string[]) => Promise<void>;
}

export interface BundleSigningPlugin {
  readonly name: string;
  /** Returns the RSA public key used by this provider in SPKI PEM format. */
  readonly getPublicKey: (input?: {
    readonly cwd?: string;
  }) => Promise<{ readonly publicKey: string }>;
  /**
   * Signs `message` with RSA PKCS#1 v1.5 SHA-256.
   *
   * Hot Updater passes the 32 raw bytes decoded from a SHA-256 file hash.
   * Remote signing services must treat this value as the raw message, not as
   * an already-computed digest.
   */
  readonly sign: (input: {
    readonly message: Uint8Array;
    readonly cwd?: string;
  }) => Promise<{ readonly signature: Uint8Array }>;
}

/** Built-in local PEM signing. */
export type LocalSigningConfig =
  | {
      readonly enabled: true;
      /** Path to an RSA private key in PEM format. */
      readonly privateKeyPath: string;
    }
  | {
      readonly enabled: false;
      readonly privateKeyPath?: string;
    };

/** Local config or signing plugin. Signing is disabled when omitted. */
export type SigningConfig = BundleSigningPlugin | LocalSigningConfig;

/**
 * Extra fingerprint sources.
 *
 * - `string[]`: shared, applied to both the iOS and Android fingerprint.
 * - object: scoped per platform, so a change to one platform's native inputs
 *   leaves the other platform's fingerprint untouched.
 */
export type FingerprintExtraSources =
  | string[]
  | {
      ios?: string[];
      android?: string[];
    };

export type ConfigInput = {
  /**
   * @hidden
   * Local cache directory used by Hot Updater CLI. Set to `null` to disable.
   *
   * @default "node_modules/.hot-updater"
   */
  cacheDir?: string | null;
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
     *
     * An array applies the sources to both platforms. Use the object form when
     * the native inputs differ per platform, so that an iOS-only change does
     * not move the Android fingerprint (and vice versa).
     *
     * @example ["resources/**", ".gitignore"]
     * @example { ios: ["ios/.env"], android: ["android/local.properties"] }
     */
    extraSources?: FingerprintExtraSources;
    /**
     * The paths to be ignored in the fingerprint.
     */
    ignorePaths?: string[];
    /**
     * When debug mode is enabled, more detailed information will be exposed in fingerprint.json.
     */
    debug?: boolean;
  };
  /**
   * Optional pre-generated patch artifacts for faster OTA delivery.
   *
   * When enabled, `hot-updater deploy` tries to prepare binary patches against
   * up to `maxBaseBundles` recent compatible bundles. Patch generation is an
   * optimization only; archive delivery remains the fallback path.
   *
   * @default { enabled: true, maxBaseBundles: 3 }
   */
  patch?: {
    /**
     * Enable automatic patch generation during deploy.
     *
     * @default true
     */
    enabled?: boolean;
    /**
     * Maximum number of compatible older bundles to prepare patches for.
     * Must be a positive integer.
     *
     * @default 3
     */
    maxBaseBundles?: number;
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
   * @optional Feature is opt-in.
   *
   * @example
   * ```ts
   * signing: {
   *   enabled: true,
   *   privateKeyPath: './keys/private-key.pem',
   * }
   * ```
   */
  signing?: SigningConfig;
  build: (args: BasePluginArgs) => Promise<BuildPlugin> | BuildPlugin;
  storage: StoragePlugin;
  database: import("./database").BundleRepository;
};

export interface NativeBuildOptions {
  outputPath?: string;
  interactive: boolean;
  message?: string;
  scheme?: string;
}
