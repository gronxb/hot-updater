import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";
import type { UnsafeObject } from "react-native/Libraries/Types/CodegenTypes";

export interface UpdateBundleParams {
  bundleId: string;
  channel?: string;
  /**
   * Signed manifest URL for installation.
   */
  manifestUrl: string;
  /**
   * File hash/signature for the manifest file itself.
   */
  manifestFileHash: string;
  /** Optional tar.br URL; integrity and sizes come from the verified manifest. */
  archiveUrl?: string | null;
  /** Every target file with its download URL and optional Hermes patch. */
  assets: UnsafeObject;
  /**
   * Legacy: JavaScript from the first artifact protocol v2 SDK sends these
   * here, with only the Hermes patch in `assets`, and apps may pass them to
   * `updateBundle` as that release documented. Native keeps accepting them so
   * such OTA Bundles still install. The update check sends them to
   * `installArtifact`.
   */
  filesUrl?: string | null;
  requestHeaders?: UnsafeObject | null;
  requestTimeout?: number | null;
  /** Full Release Catalog selection receipt committed with the staged Bundle. */
  selection?: UnsafeObject | null;
}

/**
 * Artifact protocol v2: no URL per file. Native reuses local files, chooses
 * the archive or files, and POSTs the paths it downloads one by one to
 * `filesUrl` for their URLs.
 */
export interface InstallArtifactParams {
  bundleId: string;
  channel?: string;
  manifestUrl: string;
  manifestFileHash: string;
  archiveUrl?: string | null;
  /** The Hermes bytecode patch from the running Bundle, with its `assetPath`. */
  patch?: UnsafeObject | null;
  filesUrl: string;
  /** Headers for the `filesUrl` request, as the update check sent them. */
  requestHeaders?: UnsafeObject | null;
  /** Milliseconds the `filesUrl` request may take, as the update check's. */
  requestTimeout?: number | null;
  selection?: UnsafeObject | null;
}

export interface Spec extends TurboModule {
  // Methods
  /**
   * Restarts the app process on Android and reloads React Native in place on
   * iOS, so the app loads the current bundle.
   */
  reload(): Promise<void>;
  /**
   * @deprecated Kept for JavaScript↔native compatibility within this major
   * version. Released JavaScript calls it on Android, and this SDK's
   * JavaScript still calls it on Android because an older native build's
   * `reload()` reloads React Native in place there. Native `reload()` now
   * restarts the process on Android too: the Kotlin and Objective-C
   * `reloadProcess` implementations run the same code as `reload()`, a
   * process restart on Android and an in-place reload on iOS. The next major
   * version removes it.
   */
  reloadProcess(): Promise<void>;
  /**
   * Downloads and applies a bundle update.
   *
   * @param params - Update bundle parameters
   * @returns Promise that resolves, once the bundle is staged, to how it
   *   arrived: `{ delivery, patchFallback }`. `delivery` is "patch" when a
   *   bsdiff patch produced a file, "manifest" when only changed files were
   *   downloaded, or "archive" for the full archive; `patchFallback` is true
   *   when a patch was tried but the file or archive was downloaded instead.
   * @throws {HotUpdaterErrorCode} Rejects with one of the following error codes:
   *
   *   Parameter validation:
   *   - MISSING_BUNDLE_ID: Missing or empty bundleId
   *   - INVALID_FILE_URL: Invalid manifest or asset URL provided
   *
   *   Bundle storage:
   *   - DIRECTORY_CREATION_FAILED: Failed to create bundle directory
   *   - DOWNLOAD_FAILED: Failed to download bundle
   *   - INCOMPLETE_DOWNLOAD: Download incomplete (size mismatch)
   *   - INVALID_BUNDLE: Bundle missing required platform files
   *   - INSUFFICIENT_DISK_SPACE: Insufficient disk space
   *   - MOVE_OPERATION_FAILED: Failed to move bundle files
   *   - BUNDLE_IN_CRASHED_HISTORY: Bundle was previously marked as crashed
   *
   *   Signature:
   *   - SIGNATURE_VERIFICATION_FAILED: Any signature/hash verification failure
   *
   *   Internal:
   *   - SELF_DEALLOCATED: Native object was deallocated (iOS)
   *   - UNKNOWN_ERROR: Fallback for rare or platform-specific errors
   *
   *   Note: iOS normalizes rare signature/storage errors to SIGNATURE_VERIFICATION_FAILED
   *   or UNKNOWN_ERROR to keep the JS error surface small.
   *
   *   A rejection from the download or install also carries `userInfo`
   *   `{ stage, reason, resource?, httpStatus?, transport?, originCode? }`:
   *   `stage` is "download" (transfer and verification) or "install" (patch,
   *   extract, move into place); `reason` is one of "network", "http",
   *   "invalid_response", "hash_mismatch", "signature", "patch", "extract",
   *   "storage", or "unknown"; `resource` is what was being fetched or
   *   applied: "manifest", "file", "patch", or "archive". `httpStatus` is
   *   present when `reason` is "http", with `originCode`, the storage
   *   origin's XML error `<Code>` when the body names one. `transport` is
   *   present when no response arrived: "timeout", "dns", "tls",
   *   "connection", "offline", or "cancelled".
   */
  updateBundle(params: UpdateBundleParams): Promise<UnsafeObject>;

  /**
   * Stages a Bundle over artifact protocol v2 and resolves like
   * `updateBundle`. Native built from an SDK older than protocol v2 lacks
   * it, so JS checks for it before asking the server for v2.
   */
  installArtifact(params: InstallArtifactParams): Promise<UnsafeObject>;

  /** Accepts and durably advances the catalog high-water for a scope. */
  acceptReleaseCatalog(params: UnsafeObject): boolean;

  /** Reads active/stable selection receipts and catalog high-water state. */
  getActiveUpdateState(): UnsafeObject;

  /** Reads a checksum-verified Release Catalog cache entry. */
  getReleaseCatalogCache(partition: string): Promise<string | null>;

  /** Atomically stores a bounded Release Catalog cache entry. */
  setReleaseCatalogCache(partition: string, payload: string): Promise<boolean>;

  /** Removes an incompatible Release Catalog cache entry. */
  removeReleaseCatalogCache(partition: string): Promise<boolean>;

  /** Rechecks generation/context immediately before a catalog side effect. */
  isReleaseSelectionCurrent(params: UnsafeObject): boolean;

  /** Atomically commits a metadata-only or BUILTIN selection. */
  commitReleaseSelection(params: UnsafeObject): Promise<boolean>;

  /**
   * Reads the launch report for the current process.
   * This is a read-only API; native launch state has already been finalized.
   *
   * @returns Object describing whether launch state changed and, for qualifying
   * transitions, the relevant bundle ids plus persisted transition metadata.
   */
  notifyAppReady(): {
    status: "PENDING" | "UNCHANGED" | "UPDATE_APPLIED" | "RECOVERED";
    fromReleaseId?: string;
    fromBundleId?: string;
    toReleaseId?: string;
    toBundleId?: string;
    updateStrategy?: "fingerprint" | "appVersion";
  };

  /**
   * Gets the list of bundle IDs that have been marked as crashed.
   * These bundles will be rejected if attempted to install again.
   *
   * @returns Array of crashed bundle IDs
   */
  getCrashHistory(): string[];

  /**
   * Clears the crashed bundle history, allowing previously crashed bundles
   * to be installed again.
   *
   * @returns true if clearing was successful
   */
  clearCrashHistory(): boolean;

  /**
   * Clears the runtime channel override and restores the original bundle.
   *
   * @returns Promise that resolves to true if successful
   */
  resetChannel(): Promise<boolean>;

  /**
   * Clears the runtime channel and restores the original bundle, as
   * `resetChannel` does, only while the Release selection `params` names is
   * current: native checks the catalog and resets in one step. Resolves
   * false for a stale selection. Native built from an earlier SDK has no
   * such method; JavaScript checks for it.
   */
  resetChannelIfSelectionCurrent(params: UnsafeObject): Promise<boolean>;

  /**
   * Gets the base URL for the current active bundle directory.
   * Returns the file:// URL to the bundle directory without trailing slash.
   * This is used for Expo DOM components to construct full asset paths.
   *
   * @returns Base URL string (e.g., "file:///data/.../bundle-store/abc123") or null if not available
   */
  getBaseURL: () => string | null;

  /**
   * Gets the current active bundle ID from native bundle storage.
   * Native reads it from the extracted bundle's manifest. Built-in bundle
   * fallback is handled in JS.
   *
   * @returns Active bundle ID from bundle storage, or null when unavailable
   */
  getBundleId: () => string | null;

  /**
   * Gets the current manifest from native bundle storage.
   * Returns an empty object when manifest.json is missing or invalid.
   */
  getManifest: () => UnsafeObject;

  /**
   * Sets the persisted cohort used for rollout calculations.
   *
   * Native only derives a device-based cohort when nothing has been stored
   * yet. Call `getCohort()` first if the app needs to save that initial value
   * for a later restore.
   */
  setCohort: (cohort: string) => void;

  /**
   * Gets the persisted cohort used for rollout calculations.
   * If none has been stored yet, native derives the initial value once and
   * persists it before returning.
   */
  getCohort: () => string;

  /**
   * Gets the install id: a random id native creates once per app
   * installation and keeps out of device backups.
   */
  getInstallId: () => string;

  /**
   * Reads a value from the SDK's persistent key-value store, which native
   * keeps out of device backups. Returns null when the key has no value.
   */
  getStorageItem: (key: string) => string | null;

  /**
   * Writes a value to the SDK's persistent key-value store; null removes the
   * key.
   */
  setStorageItem: (key: string, value: string | null) => void;

  /**
   * Takes the events of the update checks native code ran without JavaScript
   * (a native `HotUpdaterInstance`), as a JSON array, and clears them in one
   * step.
   * Returns null when there are none.
   */
  takeNativeUpdateEvents: () => string | null;

  /**
   * Reads `{ bundleId, pendingBundleId }` as JSON: the bundle this runtime
   * runs and, when the next launch runs another, that bundle. Optional because
   * native built from an earlier SDK lacks it; JavaScript checks for it.
   */
  getUpdateStatus?: () => Promise<string>;

  /**
   * Reads the retained update log as a JSON array, oldest first. Optional
   * because native built from an earlier SDK lacks it; JavaScript checks for
   * it.
   */
  getUpdateLogs?: () => Promise<string>;

  /**
   * Deletes the update log. Optional because native built from an earlier SDK
   * lacks it; JavaScript checks for it.
   */
  clearUpdateLogs?: () => Promise<boolean>;

  /**
   * Appends one JSON entry of an update check JavaScript ran to the update
   * log; native stamps its time and keeps only the fields it knows. Optional
   * because native built from an earlier SDK lacks it; JavaScript checks for
   * it.
   */
  appendUpdateLog?: (entry: string) => void;

  // EventEmitter
  addListener(eventName: string): void;
  removeListeners(count: number): void;
  readonly getConstants: () => {
    MIN_BUNDLE_ID: string;
    APP_VERSION: string | null;
    CHANNEL: string;
    DEFAULT_CHANNEL: string;
    FINGERPRINT_HASH: string | null;
  };
}

export default TurboModuleRegistry.getEnforcing<Spec>("HotUpdater");
