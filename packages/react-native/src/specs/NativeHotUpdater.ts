import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";
import type { UnsafeObject } from "react-native/Libraries/Types/CodegenTypes";

export interface ChangedAsset {
  fileUrl?: string | null;
  fileCompression?: "br" | null;
  fileHash: string;
  patch?: {
    algorithm: "bsdiff";
    baseBundleId: string;
    baseFileHash: string;
    patchFileHash: string;
    patchUrl: string;
  } | null;
}

export interface UpdateBundleParams {
  bundleId: string;
  channel?: string;
  fileUrl: string | null;
  /**
   * File hash for integrity/signature verification.
   *
   * Format depends on signing configuration:
   * - Signed: `sig:<base64_signature>` - Native will verify signature (and implicitly hash)
   * - Unsigned: `<hex_hash>` - Native will verify SHA256 hash only
   *
   * Native determines verification mode by checking for "sig:" prefix.
   */
  fileHash: string | null;
  /**
   * Optional signed manifest URL for manifest-driven installation.
   */
  manifestUrl?: string | null;
  /**
   * File hash/signature for the manifest file itself.
   */
  manifestFileHash?: string | null;
  /**
   * Per-file URLs for assets that must be downloaded instead of reused from
   * the currently active bundle.
   */
  changedAssets?: UnsafeObject | null;
}

export interface Spec extends TurboModule {
  // Methods
  reload(): Promise<void>;
  /**
   * Android process restart path used by `setReloadBehavior("processRestart")`.
   *
   * iOS exposes the same method name for API parity, but it behaves the same as `reload()`.
   */
  reloadProcess(): Promise<void>;
  /**
   * Downloads and applies a bundle update.
   *
   * @param params - Update bundle parameters
   * @returns Promise that resolves to true if successful
   * @throws {HotUpdaterErrorCode} Rejects with one of the following error codes:
   *
   *   Parameter validation:
   *   - MISSING_BUNDLE_ID: Missing or empty bundleId
   *   - INVALID_FILE_URL: Invalid fileUrl provided
   *
   *   Bundle storage:
   *   - DIRECTORY_CREATION_FAILED: Failed to create bundle directory
   *   - DOWNLOAD_FAILED: Failed to download bundle
   *   - INCOMPLETE_DOWNLOAD: Download incomplete (size mismatch)
   *   - EXTRACTION_FORMAT_ERROR: Invalid or corrupted archive format
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
   */
  updateBundle(params: UpdateBundleParams): Promise<boolean>;

  /**
   * Reads the launch report for the current process.
   * This is a read-only API; native launch state has already been finalized.
   *
   * @returns Object with status and optional crashedBundleId
   * - `status: "RECOVERED"` - App recovered from crash, rollback occurred (ROLLBACK event)
   * - `status: "STABLE"` - No changes, already stable
   * - `crashedBundleId` - Present only when status is "RECOVERED"
   */
  notifyAppReady(): {
    status: "RECOVERED" | "STABLE";
    crashedBundleId?: string;
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
   * Gets the base URL for the current active bundle directory.
   * Returns the file:// URL to the bundle directory without trailing slash.
   * This is used for Expo DOM components to construct full asset paths.
   *
   * @returns Base URL string (e.g., "file:///data/.../bundle-store/abc123") or null if not available
   */
  getBaseURL: () => string | null;

  /**
   * Gets the current active bundle ID from native bundle storage.
   * Native reads the extracted bundle manifest first and falls back to the
   * legacy BUNDLE_ID file when needed. Built-in bundle fallback is handled in JS.
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
