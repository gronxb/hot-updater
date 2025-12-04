import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface UpdateBundleParams {
  bundleId: string;
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
   * Optional identifier to target a specific HotUpdater instance.
   *
   * Use this in brownfield apps with multiple React Native views.
   * The identifier must match an instance created with `HotUpdater(identifier: "...")` on the native side.
   *
   * If not provided, uses the current module instance (backward compatibility).
   *
   * @example
   * ```typescript
   * // Target specific instance
   * await HotUpdater.updateBundle({
   *   bundleId: "123",
   *   fileUrl: "https://...",
   *   identifier: "main-view"
   * });
   * ```
   */
  identifier?: string;
}

export interface Spec extends TurboModule {
  // Methods
  reload(): Promise<void>;
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
   *   - INSTANCE_NOT_FOUND: Identifier provided but no matching instance found (iOS)
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
   * Notifies the native side that the app has successfully started with the given bundle.
   * If the bundle matches the staging bundle, it promotes to stable.
   *
   * @param params - Parameters containing the bundle ID
   * @returns Object with status and optional crashedBundleId
   * - `status: "PROMOTED"` - Staging bundle was promoted to stable (ACTIVE event)
   * - `status: "RECOVERED"` - App recovered from crash, rollback occurred (ROLLBACK event)
   * - `status: "STABLE"` - No changes, already stable
   * - `crashedBundleId` - Present only when status is "RECOVERED"
   */
  notifyAppReady(params: { bundleId: string }): {
    status: "PROMOTED" | "RECOVERED" | "STABLE";
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

  // EventEmitter
  addListener(eventName: string): void;
  removeListeners(count: number): void;
  readonly getConstants: () => {
    MIN_BUNDLE_ID: string;
    APP_VERSION: string | null;
    CHANNEL: string;
    FINGERPRINT_HASH: string | null;
  };
}

export default TurboModuleRegistry.getEnforcing<Spec>("HotUpdater");
