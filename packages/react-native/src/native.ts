import type { UpdateStatus } from "@hot-updater/core";
import { NativeEventEmitter } from "react-native";
import { HotUpdaterErrorCode, isHotUpdaterError } from "./error";
import HotUpdaterNative, {
  type UpdateBundleParams,
} from "./specs/NativeHotUpdater";

export { HotUpdaterErrorCode, isHotUpdaterError };

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

declare const __HOT_UPDATER_BUNDLE_ID: string | undefined;

export const HotUpdaterConstants = {
  HOT_UPDATER_BUNDLE_ID: __HOT_UPDATER_BUNDLE_ID || NIL_UUID,
};

export type HotUpdaterEvent = {
  onProgress: {
    progress: number;
  };
};

export const addListener = <T extends keyof HotUpdaterEvent>(
  eventName: T,
  listener: (event: HotUpdaterEvent[T]) => void,
) => {
  const eventEmitter = new NativeEventEmitter(HotUpdaterNative);
  const subscription = eventEmitter.addListener(eventName, listener);

  return () => {
    subscription.remove();
  };
};

export type UpdateParams = UpdateBundleParams & {
  status: UpdateStatus;
};

// In-flight update deduplication by bundleId (session-scoped).
const inflightUpdates = new Map<string, Promise<boolean>>();
// Tracks the last successfully installed bundleId for this session.
let lastInstalledBundleId: string | null = null;

/**
 * Downloads files and applies them to the app.
 *
 * @param {UpdateParams} params - Parameters object required for bundle update
 * @returns {Promise<boolean>} Resolves with true if download was successful
 * @throws {Error} Rejects with error.code from HotUpdaterErrorCode enum and error.message
 */
export async function updateBundle(params: UpdateParams): Promise<boolean>;
/**
 * @deprecated Use updateBundle(params: UpdateBundleParamsWithStatus) instead
 */
export async function updateBundle(
  bundleId: string,
  fileUrl: string | null,
): Promise<boolean>;
export async function updateBundle(
  paramsOrBundleId: UpdateParams | string,
  fileUrl?: string | null,
): Promise<boolean> {
  const updateBundleId =
    typeof paramsOrBundleId === "string"
      ? paramsOrBundleId
      : paramsOrBundleId.bundleId;

  const status =
    typeof paramsOrBundleId === "string" ? "UPDATE" : paramsOrBundleId.status;

  // If we have already installed this bundle in this session, skip re-download.
  if (status === "UPDATE" && lastInstalledBundleId === updateBundleId) {
    return true;
  }

  const currentBundleId = getBundleId();

  // updateBundleId <= currentBundleId
  if (
    status === "UPDATE" &&
    updateBundleId.localeCompare(currentBundleId) <= 0
  ) {
    throw new Error(
      "Update bundle id is the same as the current bundle id. Preventing infinite update loop.",
    );
  }

  // In-flight guard: return the same promise if the same bundle is already updating.
  const existing = inflightUpdates.get(updateBundleId);
  if (existing) return existing;

  const targetFileUrl =
    typeof paramsOrBundleId === "string"
      ? (fileUrl ?? null)
      : paramsOrBundleId.fileUrl;

  const targetFileHash =
    typeof paramsOrBundleId === "string"
      ? undefined
      : paramsOrBundleId.fileHash;

  const targetIdentifier =
    typeof paramsOrBundleId === "string"
      ? undefined
      : paramsOrBundleId.identifier;

  const promise = (async () => {
    try {
      const ok = await HotUpdaterNative.updateBundle({
        bundleId: updateBundleId,
        fileUrl: targetFileUrl,
        fileHash: targetFileHash ?? null,
        identifier: targetIdentifier,
      });
      if (ok) {
        lastInstalledBundleId = updateBundleId;
      }
      return ok;
    } finally {
      inflightUpdates.delete(updateBundleId);
    }
  })();

  inflightUpdates.set(updateBundleId, promise);
  return promise;
}

/**
 * Fetches the current app version.
 */
export const getAppVersion = (): string | null => {
  const constants = HotUpdaterNative.getConstants();
  return constants?.APP_VERSION ?? null;
};

/**
 * Reloads the app.
 */
export const reload = async () => {
  await HotUpdaterNative.reload();
};

/**
 * Fetches the minimum bundle id, which represents the initial bundle of the app
 * since it is created at build time.
 *
 * @returns {string} Resolves with the minimum bundle id or null if not available.
 */
export const getMinBundleId = (): string => {
  const constants = HotUpdaterNative.getConstants();
  return constants.MIN_BUNDLE_ID;
};

/**
 * Fetches the current bundle version id.
 *
 * @async
 * @returns {string} Resolves with the current version id or null if not available.
 */
export const getBundleId = (): string => {
  return HotUpdaterConstants.HOT_UPDATER_BUNDLE_ID === NIL_UUID
    ? getMinBundleId()
    : HotUpdaterConstants.HOT_UPDATER_BUNDLE_ID;
};

/**
 * Fetches the channel for the app.
 *
 * @returns {string} Resolves with the channel or null if not available.
 */
export const getChannel = (): string => {
  const constants = HotUpdaterNative.getConstants();
  return constants.CHANNEL;
};

/**
 * Fetches the fingerprint for the app.
 *
 * @returns {string | null} Resolves with the fingerprint hash
 */
export const getFingerprintHash = (): string | null => {
  const constants = HotUpdaterNative.getConstants();
  return constants.FINGERPRINT_HASH;
};

/**
 * Result returned by notifyAppReady()
 */
export type NotifyAppReadyResult = {
  status: "PROMOTED" | "RECOVERED" | "STABLE";
  crashedBundleId?: string;
};

/**
 * Notifies the native side that the app has successfully started with the current bundle.
 * If the bundle matches the staging bundle, it promotes to stable.
 *
 * This function is called automatically when the module loads.
 *
 * @returns {NotifyAppReadyResult} Bundle state information
 * - `status: "PROMOTED"` - Staging bundle was promoted to stable (ACTIVE event)
 * - `status: "RECOVERED"` - App recovered from crash, rollback occurred (ROLLBACK event)
 * - `status: "STABLE"` - No changes, already stable
 * - `crashedBundleId` - Present only when status is "RECOVERED"
 *
 * @example
 * ```ts
 * const result = HotUpdater.notifyAppReady();
 *
 * switch (result.status) {
 *   case "PROMOTED":
 *     // Send ACTIVE analytics event
 *     analytics.track('bundle_active', { bundleId: HotUpdater.getBundleId() });
 *     break;
 *   case "RECOVERED":
 *     // Send ROLLBACK analytics event
 *     analytics.track('bundle_rollback', { crashedBundleId: result.crashedBundleId });
 *     break;
 *   case "STABLE":
 *     // No special action needed
 *     break;
 * }
 * ```
 */
export const notifyAppReady = (): NotifyAppReadyResult => {
  const bundleId = getBundleId();
  return HotUpdaterNative.notifyAppReady({ bundleId });
};

/**
 * Gets the list of bundle IDs that have been marked as crashed.
 * These bundles will be rejected if attempted to install again.
 *
 * @returns {string[]} Array of crashed bundle IDs
 */
export const getCrashHistory = (): string[] => {
  const result = HotUpdaterNative.getCrashHistory();
  // Oldarch returns JSON string, newarch returns array
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return [];
    }
  }
  return result;
};

/**
 * Clears the crashed bundle history, allowing previously crashed bundles
 * to be installed again.
 *
 * @returns {boolean} true if clearing was successful
 */
export const clearCrashHistory = (): boolean => {
  return HotUpdaterNative.clearCrashHistory();
};
