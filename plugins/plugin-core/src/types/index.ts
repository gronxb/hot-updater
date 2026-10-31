import type { Bundle, Platform } from "@hot-updater/protocol";

import type { AnyHotUpdaterPlugin } from "../serverPlugin/definePlugin";
import type { ConfiguredDatabase } from "./databaseConfig";

export type { Bundle, Platform } from "@hot-updater/protocol";

export * from "./utils";
export * from "./public";

/**
 * A value, or a function that returns it, called on first use: an
 * adapter shared by servers and the CLI takes its credentials so, as a
 * string from a server's own environment or as `secret("<name>")` from
 * `hot-updater.config.ts`, which loads without reading a secret.
 */
export type Lazy<T> = T | (() => T | Promise<T>);

/** The value of a `Lazy`, calling its function. */
export const resolveLazy = async <T>(value: Lazy<T>): Promise<T> =>
  typeof value === "function" ? await (value as () => T | Promise<T>)() : value;

/**
 * The brand of a `SecretRef`, `Symbol.for("@hot-updater/secret-ref")` at
 * runtime: `hot-updater`'s `secret()` sets it, and the CLI recognizes a
 * reference by it, so a plain string or function is none.
 */
declare const secretRefBrand: unique symbol;

/**
 * `secret("<name>")` in `hot-updater.config.ts`: the secret the config's
 * `secrets` adapter holds as `name`. Called, it reads the value, the
 * environment first, so it is a `Lazy<string>` any adapter credential
 * takes; the build credentials, such as `signing.keystore`, take only a
 * reference, which the CLI resolves by `name` for its kind.
 */
export type SecretRef = (() => Promise<string>) & {
  readonly [secretRefBrand]: true;
  /** The secret's name in the config's `secrets` adapter. */
  readonly name: string;
};

export interface BuildAdapterArgs {
  cwd: string;
}

export interface BuildAdapterConfig {
  outDir?: string;
}

/**
 * One input of a native fingerprint, listed in fingerprint.json so doctor and
 * deploy can show what changed. A build adapter's fingerprint returns these.
 */
export type NativeFingerprintSource =
  | {
      type: "file" | "dir";
      filePath: string;
      reasons: string[];
      hash: string | null;
      debugInfo?: unknown;
    }
  | {
      type: "contents";
      id: string;
      contents: string | Uint8Array;
      reasons: string[];
      hash: string | null;
      debugInfo?: unknown;
    };

/** What a build adapter's fingerprint computes for one platform. */
export interface NativeFingerprint {
  /**
   * What computed `hash`, such as `hot-updater/interface@1`. fingerprint.json
   * records it, so a hash that changes with its engine is reported as such.
   */
  engine?: string;
  hash: string;
  sources: NativeFingerprintSource[];
}

/** The `fingerprint` settings of hot-updater.config.ts, for one platform. */
export interface NativeFingerprintOptions {
  platform: Platform;
  extraSources?: FingerprintExtraSources;
  ignorePaths?: string[];
  nativeVersion?: string | number;
  debug?: boolean;
}

/**
 * Computes the native fingerprint of a project for one platform. A build
 * adapter implements it to fingerprint the native interface its framework
 * exposes to JavaScript.
 */
export type NativeFingerprintProvider = (
  options: NativeFingerprintOptions,
) => Promise<NativeFingerprint>;

export interface BuildAdapter {
  nativeBuild?: {
    /**
     * Fingerprints the native interface JavaScript depends on. Without it, the
     * CLI uses React Native CLI's: the native interface `react-native config`
     * reports. fingerprint.json records the adapter's `name`, and a native
     * build recomputes the fingerprint of `bare`, `rock`, and `expo` with
     * those official packages, so an adapter with its own fingerprint takes a
     * name of its own; a native build then embeds the recorded hash.
     */
    fingerprint?: NativeFingerprintProvider;
    /** Resolves the public key embedded by the native build configuration. */
    getBundleSigningPublicKey?: () => Promise<{
      readonly publicKey: string;
    } | null>;
    /** Resolves native configuration files that must affect the fingerprint. */
    getFingerprintExtraSources?: () => Promise<readonly string[]>;
    /**
     * What `prebuild` would write into a platform's native project, read
     * without writing it, for commands that only look the project up, such
     * as `native-build find`. A value it leaves out is read from the native
     * project as it is.
     */
    getNativeProjectValues?: (args: { platform: Platform }) => Promise<{
      /**
       * The app version the prebuild writes as the app's own: Android's
       * `defaultConfig` `versionName`, which a product flavor's still
       * overrides, and the iOS app's Info.plist.
       */
      readonly appVersion?: string;
      /** The channel the native build would embed. */
      readonly channel?: string;
    }>;
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
   * If `false`, the generated artifact type is `.apk`.
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

  /**
   * Signs a release variant with a keystore the CLI resolves: `keystore` is
   * `secret("<name>")`, the `android-keystore` the config's `secrets` adapter
   * holds as `<name>`, which the `HOT_UPDATER_ANDROID_KEYSTORE_*`
   * environment variables override. Debug variants keep the debug keystore
   * and resolve nothing. Without it, the variant's own `signingConfig` signs.
   *
   * @example { keystore: secret("release-keystore") }
   */
  signing?: { keystore: SecretRef };
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
   * Path to a plist file that specifies options for exporting the archive
   * into an `.ipa`. A device build needs it unless `signing.ascApiKey` is
   * set, which exports for App Store Connect with automatic signing.
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
   * @default false
   */
  simulator?: boolean;

  /**
   * Signs a device build with automatic signing, authenticated by an App
   * Store Connect API key the CLI resolves: `ascApiKey` is `secret("<name>")`,
   * the `asc-api-key` the config's `secrets` adapter holds as `<name>`,
   * which the `HOT_UPDATER_ASC_KEY*` environment variables override.
   * Simulator builds resolve nothing. Without it, the project's signing
   * settings and Xcode's accounts sign.
   *
   * @example { ascApiKey: secret("asc-api-key") }
   */
  signing?: { ascApiKey: SecretRef };
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
  /** Object key relative to the storage adapter's configured base path. */
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
export interface StorageAdapter {
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

/**
 * What a secrets adapter is given with each call. It carries no secret: an
 * adapter reads its own credentials, such as a token or a CLI sign-in.
 */
export interface SecretsContext {
  /** The project directory the CLI runs in. */
  readonly cwd: string;
}

/**
 * Where the CLI reads the secrets `secret("<name>")` names in a config: build
 * credentials, such as a keystore, and adapter credentials. Values
 * are strings: binary is base64, and a credential with several fields is one
 * JSON value per name. `localSecrets()`, an export of `hot-updater`, keeps them
 * in files on this machine, and `infisical()`, another, in an Infisical
 * project; a store of your own implements this.
 */
export interface SecretsAdapter {
  readonly name: string;
  /**
   * Reads `names` in one call. A name the store does not hold maps to
   * `undefined`; any other failure, such as a missing permission or an
   * unreachable store, throws.
   */
  readonly get: (
    names: readonly string[],
    context: SecretsContext,
  ) => Promise<Readonly<Record<string, string | undefined>>>;
  /**
   * Stores `value` as `name`, replacing what it held. Every adapter stores:
   * the CLI keeps the keys it issues and imports here, and nowhere else. A
   * write the store refuses, such as with a read-only token, throws.
   */
  readonly set: (
    name: string,
    value: string,
    context: SecretsContext,
  ) => Promise<void>;
  /** Where the user finds `name` in the store, such as a URL or a path, for messages. */
  readonly describe?: (name: string) => string;
}

/**
 * Built-in local PEM signing, with the RSA private key from a file or from
 * the config's `secrets` adapter.
 */
export type LocalSigningConfig =
  | {
      readonly enabled: true;
      /** Path to an RSA private key in PEM format. */
      readonly privateKeyPath: string;
      readonly privateKey?: never;
    }
  | {
      readonly enabled: true;
      /**
       * `secret("<name>")`, the RSA private key in PEM format that the
       * config's `secrets` adapter holds as `<name>`. The CLI reads it once
       * per run, when it first signs or derives the public key, and keeps it
       * in memory only.
       *
       * @example { enabled: true, privateKey: secret("bundle-signing-key") }
       */
      readonly privateKey: SecretRef;
      readonly privateKeyPath?: never;
    }
  | {
      readonly enabled: false;
      readonly privateKeyPath?: string;
      readonly privateKey?: SecretRef;
    };

/**
 * Bundle signing with an RSA private key in PEM. `secret("<name>")` is the
 * shorthand of `{ enabled: true, privateKey: secret("<name>") }`. Without
 * `signing`, bundles are unsigned and deploy warns; `enabled: false` turns
 * signing off without the warning.
 */
export type SigningConfig = SecretRef | LocalSigningConfig;

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
     * The paths to be ignored in the fingerprint. The bare and Rock adapters
     * apply them to `extraSources`.
     */
    ignorePaths?: string[];
    /**
     * A version you change when JavaScript starts to depend on a native change
     * the fingerprint can't see, such as a native module without a codegen
     * spec, a new permission, or a manually linked library. Changing it
     * changes the fingerprint.
     *
     * @example 2
     */
    nativeVersion?: string | number;
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
   * optimization only; the original manifest asset remains the fallback path.
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
   * Signs each bundle with RSA-SHA256, which the app verifies with the
   * public key it embeds. `secret("bundle-signing-key")` reads the RSA
   * private key in PEM from the config's `secrets` adapter; the object
   * forms take it from a secret (`privateKey`) or a file
   * (`privateKeyPath`). Without `signing`, bundles are unsigned and deploy
   * warns; `{ enabled: false }` turns signing off without the warning.
   *
   * @example
   * ```ts
   * signing: secret("bundle-signing-key"),
   * ```
   */
  signing?: SigningConfig;
  /**
   * Where the CLI reads the secrets the config names with `secret("<name>")`,
   * after the environment, and stores the keys it issues. It is the only
   * store: nothing is kept on this machine under it.
   *
   * @default localSecrets()
   */
  secrets?: SecretsAdapter;
  build: (args: BuildAdapterArgs) => Promise<BuildAdapter> | BuildAdapter;
  /** Where the CLI uploads bundles: the same adapter as the server's `storage`. */
  storage: StorageAdapter;
  /**
   * The server's database, which the CLI opens itself, or
   * `standaloneRepository(...)`, which reaches a self-hosted server through
   * its admin API.
   */
  database: ConfiguredDatabase;
  /**
   * The plugins the server runs, as its definition lists them. Over the
   * server's database the CLI runs them as the server does; with
   * `standaloneRepository`, they run on the server.
   */
  plugins?: readonly AnyHotUpdaterPlugin[];
};

export interface NativeBuildOptions {
  outputPath?: string;
  interactive: boolean;
  scheme?: string;
}
