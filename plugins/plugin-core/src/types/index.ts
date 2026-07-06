import type {
  Bundle,
  GetBundlesArgs,
  Platform,
  UpdateInfo,
} from "@hot-updater/core";

export type {
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  GetBundlesArgs,
  Platform,
  UpdateInfo,
} from "@hot-updater/core";

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
  nextCursor?: string | null;
  previousCursor?: string | null;
}

export interface Paginated<TData> {
  data: TData;
  pagination: PaginationInfo;
}

export type PaginatedResult = Paginated<Bundle[]>;

export type MaybePromise<T> = T | PromiseLike<T>;

type DeprecatedBundlePatchKeys =
  | "patches"
  | "patchBaseBundleId"
  | "patchBaseFileHash"
  | "patchFileHash"
  | "patchStorageUri";

export type DatabaseBundleRecord = Omit<Bundle, DeprecatedBundlePatchKeys>;

export interface CursorPage<TData> {
  readonly data: readonly TData[];
  readonly pagination: {
    readonly total?: number;
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
    readonly currentPage?: number;
    readonly totalPages?: number;
    readonly nextCursor: string | null;
    readonly previousCursor: string | null;
  };
}

export interface DatabaseBundleIdFilter {
  eq?: string;
  gt?: string;
  gte?: string;
  lt?: string;
  lte?: string;
  in?: string[];
}

export interface DatabaseBundleQueryWhere {
  channel?: string;
  platform?: Platform;
  enabled?: boolean;
  id?: DatabaseBundleIdFilter;
  targetAppVersion?: string | null;
  targetAppVersionIn?: string[];
  targetAppVersionNotNull?: boolean;
  fingerprintHash?: string | null;
}

export interface DatabaseBundleQueryOrder {
  field: "id";
  direction: "asc" | "desc";
}

export interface DatabaseBundleCursor {
  /**
   * Fetch the next window after this bundle ID.
   *
   * This is the preferred pagination mode for bundle-management queries.
   */
  after?: string;
  /**
   * Fetch the previous window before this bundle ID.
   *
   * This is the preferred pagination mode for bundle-management queries.
   */
  before?: string;
}

export interface DatabaseBundleQueryOptions {
  where?: DatabaseBundleQueryWhere;
  limit: number;
  /**
   * Optional page number used by management UIs to keep page boundaries stable
   * even when new bundles are inserted ahead of the current cursor window.
   */
  page?: number;
  /**
   * Preferred cursor-based pagination for bundle-management queries.
   */
  cursor?: DatabaseBundleCursor;
  orderBy?: DatabaseBundleQueryOrder;
}

export type BundleListQuery = DatabaseBundleQueryOptions;

export interface DatabaseBundlePatch {
  readonly id?: string;
  readonly bundleId: string;
  readonly baseBundleId: string;
  readonly baseFileHash: string;
  readonly patchFileHash: string;
  readonly patchStorageUri: string;
  readonly orderIndex: number;
}

export interface BundlePatchListQuery {
  readonly where?: {
    readonly bundleId?: string;
    readonly baseBundleId?: string;
    readonly bundleIdIn?: readonly string[];
    readonly baseBundleIdIn?: readonly string[];
  };
  readonly limit: number;
  readonly cursor?: {
    readonly after?: string;
    readonly before?: string;
  };
  readonly orderBy?: {
    readonly field: "bundleId" | "baseBundleId" | "orderIndex";
    readonly direction: "asc" | "desc";
  };
}

export type BundleEventKind = "APP_READY";

export interface AppReadyBundleEventPayload {
  readonly status: "STABLE" | "RECOVERED";
  readonly sdkVersion: string;
  readonly defaultChannel: string;
  readonly isChannelSwitched: boolean;
}

export type BundleEventPayload = AppReadyBundleEventPayload;

export interface DatabaseBundleEventInput {
  readonly kind: BundleEventKind;
  readonly installId: string;
  readonly activeBundleId: string;
  readonly previousActiveBundleId?: string | null;
  readonly crashedBundleId?: string | null;
  readonly platform: Platform;
  readonly channel: string;
  readonly appVersion?: string | null;
  readonly fingerprintHash?: string | null;
  readonly cohort?: string | null;
  readonly payload: BundleEventPayload;
}

export interface DatabaseBundleEvent extends DatabaseBundleEventInput {
  readonly id: string;
}

export interface BundleEventListQuery {
  readonly where?: {
    readonly kind?: BundleEventKind;
    readonly installId?: string;
    readonly activeBundleId?: string;
    readonly previousActiveBundleId?: string;
    readonly crashedBundleId?: string;
    readonly platform?: Platform;
    readonly channel?: string;
    readonly appVersion?: string;
    readonly fingerprintHash?: string;
    readonly cohort?: string;
  };
  readonly limit: number;
  readonly cursor?: {
    readonly after?: string;
    readonly before?: string;
  };
  readonly orderBy?: {
    readonly field: "id";
    readonly direction: "asc" | "desc";
  };
}

export interface BundleRepository {
  readonly getById: (params: {
    readonly bundleId: string;
  }) => Promise<DatabaseBundleRecord | null>;
  readonly list: (
    params: BundleListQuery,
  ) => Promise<CursorPage<DatabaseBundleRecord>>;
}

export interface RuntimeBundleRepository extends BundleRepository {
  readonly insert: (params: {
    readonly bundle: DatabaseBundleRecord;
  }) => Promise<void>;
  readonly update: (params: {
    readonly bundleId: string;
    readonly patch: Partial<DatabaseBundleRecord>;
  }) => Promise<void>;
  readonly delete: (params: { readonly bundleId: string }) => Promise<void>;
}

export type BundleResource = RuntimeBundleRepository;

export interface BundlePatchRepository {
  readonly list: (
    params: BundlePatchListQuery,
  ) => Promise<CursorPage<DatabaseBundlePatch>>;
}

export interface RuntimeBundlePatchRepository extends BundlePatchRepository {
  readonly replaceForBundle: (params: {
    readonly bundleId: string;
    readonly patches: readonly DatabaseBundlePatch[];
  }) => Promise<void>;
  readonly deleteForBundle: (params: {
    readonly bundleId: string;
  }) => Promise<void>;
  readonly deleteForBaseBundle: (params: {
    readonly baseBundleId: string;
  }) => Promise<void>;
}

export type BundlePatchResource = RuntimeBundlePatchRepository;

export interface BundleEventRepository {
  readonly list: (
    params: BundleEventListQuery,
  ) => Promise<CursorPage<DatabaseBundleEvent>>;
}

export interface RuntimeBundleEventRepository extends BundleEventRepository {
  readonly append: (params: {
    readonly event: DatabaseBundleEventInput;
  }) => Promise<void>;
}

export interface BundleEventResource extends BundleEventRepository {
  readonly append: (params: {
    readonly event: DatabaseBundleEvent;
  }) => Promise<void>;
}

export interface UpdateInfoRepository {
  readonly get: (params: GetBundlesArgs) => Promise<UpdateInfo | null>;
}

export interface DatabaseTransaction {
  readonly core: DatabasePluginCore;
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}

export interface DatabasePluginCore {
  readonly beginTransaction?: () => Promise<DatabaseTransaction>;
  readonly bundles: BundleResource;
  readonly bundlePatches: BundlePatchResource;
  readonly bundleEvents?: BundleEventResource;
  readonly updateInfo?: UpdateInfoRepository;
  readonly close?: () => Promise<void>;
}

export interface DatabaseCommitBatch {
  readonly mutations: readonly DatabaseMutation[];
}

export interface DatabaseCommitParams {
  readonly batch?: DatabaseCommitBatch;
}

export type BundleMutation =
  | { readonly kind: "bundle.insert"; readonly bundle: DatabaseBundleRecord }
  | {
      readonly kind: "bundle.update";
      readonly bundleId: string;
      readonly patch: Partial<DatabaseBundleRecord>;
    }
  | { readonly kind: "bundle.delete"; readonly bundleId: string };

export type BundlePatchMutation =
  | {
      readonly kind: "bundlePatch.replaceForBundle";
      readonly bundleId: string;
      readonly patches: readonly DatabaseBundlePatch[];
    }
  | { readonly kind: "bundlePatch.deleteForBundle"; readonly bundleId: string }
  | {
      readonly kind: "bundlePatch.deleteForBaseBundle";
      readonly baseBundleId: string;
    };

export type BundleEventMutation = {
  readonly kind: "bundleEvent.append";
  readonly event: DatabaseBundleEvent;
};

export type DatabaseMutation =
  | BundleMutation
  | BundlePatchMutation
  | BundleEventMutation;

export interface DatabasePluginRuntime {
  readonly name: string;
  readonly bundles: RuntimeBundleRepository;
  readonly bundlePatches: RuntimeBundlePatchRepository;
  readonly bundleEvents?: RuntimeBundleEventRepository;
  readonly updateInfo?: UpdateInfoRepository;
  readonly commit: (params?: DatabaseCommitParams) => Promise<void>;
  readonly close?: () => Promise<void>;
}

export interface BuildPluginConfig {
  outDir?: string;
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

    /**
     * Android string resource paths.
     *
     * @deprecated Android Hot Updater config is stored in AndroidManifest.xml.
     * This remains supported as a legacy read fallback.
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

export interface RequestEnvContext<TEnv = unknown> {
  request?: Request;
  env?: TEnv;
}

export type HotUpdaterContext<TContext = unknown> = TContext;

export type StorageResolveContext<TContext = unknown> =
  HotUpdaterContext<TContext>;

export interface NodeStorageProfile {
  upload: (
    key: string,
    filePath: string,
  ) => Promise<{
    storageUri: string;
  }>;

  /**
   * Returns true when the object can be safely reused by deploy without
   * uploading it again. Providers may validate more than physical existence
   * when runtime access needs an additional readiness check.
   */
  exists: (storageUri: string) => Promise<boolean>;

  delete: (storageUri: string) => Promise<void>;

  downloadFile: (storageUri: string, filePath: string) => Promise<void>;
}

export interface RuntimeStorageProfile<TContext = unknown> {
  getDownloadUrl: (
    storageUri: string,
    context?: StorageResolveContext<TContext>,
  ) => Promise<{
    fileUrl: string;
  }>;

  readText: (
    storageUri: string,
    context?: StorageResolveContext<TContext>,
  ) => Promise<string | null>;
}

export interface StoragePluginProfiles<TContext = unknown> {
  /**
   * Node/deploy/console profile.
   *
   * Use this profile when the caller can materialize storage objects to the
   * local filesystem.
   */
  node?: NodeStorageProfile;

  /**
   * Runtime update-check profile.
   *
   * Use this profile when the caller needs signed/public client URLs and direct
   * server-side reads for small control-plane text objects such as manifests.
   */
  runtime?: RuntimeStorageProfile<TContext>;
}

export interface StoragePlugin<TContext = unknown> {
  /**
   * Protocol this storage plugin can resolve.
   * @example "s3", "r2", "supabase-storage".
   */
  supportedProtocol: string;

  name: string;

  profiles: StoragePluginProfiles<TContext>;
}

export interface NodeStoragePlugin<
  TContext = unknown,
> extends StoragePlugin<TContext> {
  profiles: {
    node: NodeStorageProfile;
    runtime?: RuntimeStorageProfile<TContext>;
  };
}

export interface RuntimeStoragePlugin<
  TContext = unknown,
> extends StoragePlugin<TContext> {
  profiles: {
    node?: NodeStorageProfile;
    runtime: RuntimeStorageProfile<TContext>;
  };
}

export interface UniversalStoragePlugin<
  TContext = unknown,
> extends StoragePlugin<TContext> {
  profiles: {
    node: NodeStorageProfile;
    runtime: RuntimeStorageProfile<TContext>;
  };
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
   * @hidden
   * Local cache directory used by Hot Updater CLI. Set to `null` to disable.
   *
   * @default "node_modules/.hot-updater"
   */
  cacheDir?: string | null;
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
  storage: () => Promise<NodeStoragePlugin> | NodeStoragePlugin;
  database:
    | MaybePromise<DatabasePluginRuntime>
    | (() => MaybePromise<DatabasePluginRuntime>);
};

export interface NativeBuildOptions {
  outputPath?: string;
  interactive: boolean;
  message?: string;
  scheme?: string;
}
