/**
 * The client plugin contract. Built-in plugins, such as Insights, and
 * third-party plugins use the same one, as server plugins do. Plugins import
 * it from here, and apps through `@hot-updater/react-native`.
 *
 * Keep this module free of state and of classes that code checks with
 * `instanceof`. A plugin can load it in one module format while the app loads
 * it in the other, so two copies can run side by side.
 */

export type UpdateStrategy = "fingerprint" | "appVersion";

/** How an update moves the app's selection. */
export type ReleaseTransitionKind =
  | "INSTALL"
  | "ADOPT_RELEASE"
  | "USE_EMBEDDED"
  | "USE_BUILTIN";

/** The launch outcome native reports once per JavaScript runtime. */
export type AppReadyResult =
  | {
      /** No update was applied or recovered at this launch. */
      readonly status: "UNCHANGED";
      readonly channel: string;
      /** The running bundle. */
      readonly bundleId: string;
      /** The Release the running bundle was selected as, when known. */
      readonly releaseId: string | null;
    }
  | {
      /**
       * `UPDATE_APPLIED`: a staged update became active at this launch.
       * `RECOVERED`: a failed update was rolled back to `toBundleId`.
       */
      readonly status: "UPDATE_APPLIED" | "RECOVERED";
      readonly channel: string;
      readonly fromBundleId: string;
      readonly fromReleaseId: string | null;
      readonly toBundleId: string;
      readonly toReleaseId: string | null;
      readonly updateStrategy: UpdateStrategy;
    };

/** What an update check found. */
export type UpdateCheckResult =
  | {
      /**
       * The app keeps running its bundle: the check found nothing to
       * install, or the app adopted a newer Release of the running bundle.
       */
      readonly status: "UNCHANGED";
      readonly channel: string;
      readonly bundleId: string;
      /** The Release the running bundle is selected as after the check. */
      readonly releaseId: string | null;
      /** The Release before the check; it differs after an adoption. */
      readonly previousReleaseId: string | null;
    }
  | {
      /** The check found a Release to install, adopt, or roll back to. */
      readonly status: "UPDATE_AVAILABLE";
      readonly channel: string;
      readonly fromBundleId: string;
      readonly fromReleaseId: string | null;
      readonly toBundleId: string;
      readonly toReleaseId: string | null;
      readonly transitionKind: ReleaseTransitionKind;
      readonly updateStatus: "UPDATE" | "ROLLBACK";
      readonly shouldForceUpdate: boolean;
      readonly updateStrategy: UpdateStrategy;
    };

/** A bundle the SDK downloaded, verified, and staged for the next launch. */
export interface BundleDownloadedInfo {
  readonly channel: string;
  readonly fromBundleId: string;
  readonly fromReleaseId: string | null;
  readonly toBundleId: string;
  readonly toReleaseId: string | null;
  readonly updateStrategy: UpdateStrategy;
  /**
   * How the bundle arrived: `patch` when a bsdiff patch produced a file,
   * `manifest` when only the changed files were downloaded, `archive` for
   * the full archive.
   */
  readonly delivery: "patch" | "manifest" | "archive";
  /** A patch was tried, but the file or the archive was downloaded instead. */
  readonly patchFallback: boolean;
}

/**
 * Where an update failed: `check` covers the Release catalog request,
 * `download` the transfer and verification of the update's files, and
 * `install` patching, extracting, and moving them into place.
 */
export type UpdateErrorStage = "check" | "download" | "install";

/** What the SDK was fetching or applying when an update failed. */
export type UpdateErrorResource =
  | "catalog"
  | "artifact"
  | "manifest"
  | "file"
  | "patch"
  | "archive";

/** Why no response arrived, for a `network` failure. */
export type UpdateErrorTransport =
  | "timeout"
  | "dns"
  | "tls"
  | "connection"
  | "offline"
  | "cancelled";

export type UpdateErrorReason =
  | "network"
  | "http"
  | "invalid_response"
  | "hash_mismatch"
  | "signature"
  | "patch"
  | "extract"
  | "storage"
  | "unknown";

/** An update check, download, or install that failed. */
export interface UpdateError {
  readonly stage: UpdateErrorStage;
  readonly reason: UpdateErrorReason;
  /** What was being fetched or applied, when the SDK knows. */
  readonly resource?: UpdateErrorResource;
  /** The response status when `reason` is `"http"`. */
  readonly httpStatus?: number;
  /**
   * The storage origin's XML error `<Code>`, such as `AccessDenied`,
   * `NoSuchKey`, or `ExpiredToken`, when an `http` failure's body names one.
   * It tells an expired signed URL from a missing file.
   */
  readonly originCode?: string;
  /** Why no response arrived, for a `network` failure, when the SDK knows. */
  readonly transport?: UpdateErrorTransport;
  /** The bundle the update targeted; absent for the check stage. */
  readonly targetBundleId?: string;
  /** The Release the update targeted, when it names one. */
  readonly targetReleaseId?: string;
  readonly channel: string;
  /** The running bundle and the Release it was selected as. */
  readonly bundleId: string;
  readonly releaseId: string | null;
  readonly updateStrategy: UpdateStrategy;
  /** The error the SDK caught. */
  readonly cause: unknown;
}

/** A response from the update server's catalog or artifact API. */
export interface UpdateHttpResponse {
  readonly resource: "catalog" | "artifact";
  /** Request path only; authentication headers and query parameters are omitted. */
  readonly path: string;
  readonly status: number;
  /** The response as text, or null if the body could not be read. */
  readonly body: string | null;
  readonly bodyTruncated: boolean;
}

/**
 * Lifecycle hooks a plugin returns from `setup`. Hooks observe: the SDK
 * never waits for one and ignores what it returns, and a hook that throws or
 * rejects is reported through `onError`, or a console warning without one,
 * so a plugin can never delay or change an update.
 */
export interface HotUpdaterClientHooks {
  /** Called once per JavaScript runtime, after native reports the launch. */
  onAppReady?(result: AppReadyResult): void | Promise<void>;
  /** Called after each update check, and after a Release adoption commits. */
  onUpdateCheck?(result: UpdateCheckResult): void | Promise<void>;
  /** Called after the SDK stages a downloaded bundle. */
  onBundleDownloaded?(info: BundleDownloadedInfo): void | Promise<void>;
  /** Called when an update check, download, or install fails. */
  onUpdateError?(error: UpdateError): void | Promise<void>;
  /** Called for every catalog/artifact API response, including 200 and 304. */
  onHttpResponse?(response: UpdateHttpResponse): void | Promise<void>;
}

/**
 * A plugin's persistent key-value store. Native keeps it on the device,
 * outside device backups, and the SDK scopes its keys to the plugin's id.
 * It is meant for small values, up to 64 KB each.
 */
export interface HotUpdaterClientStorage {
  get(key: string): string | null;
  /** Writes the value; `null` removes the key. */
  set(key: string, value: string | null): void;
}

export interface HotUpdaterClientContext {
  /**
   * Requests a path relative to the configured `baseURL`, with the SDK's
   * `requestHeaders` and `requestTimeout` applied. Rejects with
   * `Request timed out` when the timeout passes before a response arrives.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** A random id native creates once per installation. */
  readonly installId: string;
  readonly platform: "ios" | "android";
  /** The native app version, or null when the native build has none. */
  readonly appVersion: string | null;
  readonly sdkVersion: string;
  /** Whether this is a debug build (`__DEV__`). */
  readonly isDebugBuild: boolean;
  /** The bundle native reports as current. */
  getBundleId(): string;
  getChannel(): string;
  getCohort(): string;
  getFingerprintHash(): string | null;
  readonly storage: HotUpdaterClientStorage;
  /** The current time in milliseconds since the epoch. */
  now(): number;
}

export interface HotUpdaterClientPlugin {
  /** Unique among an app's plugins; two plugins with one id throw at init. */
  readonly id: string;
  /**
   * Called once, when `HotUpdater.init` or `HotUpdater.wrap` first
   * configures the runtime with this plugin.
   */
  setup(context: HotUpdaterClientContext): HotUpdaterClientHooks | void;
}

/** Declares a client plugin; built-in and third-party plugins use the same contract. */
export const defineClientPlugin = <const P extends HotUpdaterClientPlugin>(
  plugin: P,
): P => plugin;
