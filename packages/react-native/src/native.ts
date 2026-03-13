import type { UpdateStatus } from "@hot-updater/core";
import { NativeEventEmitter, Platform } from "react-native";
import { HotUpdaterErrorCode, isHotUpdaterError } from "./error";
import HotUpdaterNative, {
  type UpdateBundleParams,
} from "./specs/NativeHotUpdater";

export { HotUpdaterErrorCode, isHotUpdaterError };

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Built-in reload behaviors used by `HotUpdater.reload()`.
 *
 * - `reload`: In-process React Native reload.
 * - `processRestart`: Android-only cold restart. On iOS the same call behaves like `reload`.
 */
export type ReloadBehavior = "reload" | "processRestart";

/**
 * Custom reload hook used when `setReloadBehavior("custom", handler)` is configured.
 *
 * This is useful for brownfield apps that need to delegate reload behavior to
 * a host-native container instead of using HotUpdater's built-in reload flow.
 */
export type CustomReloadHandler = () => void | Promise<void>;

/**
 * Full reload policy accepted by `setReloadBehavior()`.
 *
 * - `reload`: Built-in React reload on both platforms
 * - `processRestart`: Android process restart, iOS behaves like `reload`
 * - `custom`: Run a user-provided JS handler on both platforms
 */
export type ReloadBehaviorSetting = ReloadBehavior | "custom";

declare const __HOT_UPDATER_BUNDLE_ID: string | undefined;

export const HotUpdaterConstants = {
  HOT_UPDATER_BUNDLE_ID: __HOT_UPDATER_BUNDLE_ID || NIL_UUID,
};

class HotUpdaterSessionState {
  private readonly defaultChannel: string;
  private currentChannel: string;
  private readonly inflightUpdates = new Map<string, Promise<boolean>>();
  private lastInstalledBundleId: string | null = null;

  constructor() {
    const constants = HotUpdaterNative.getConstants();
    this.defaultChannel = constants.DEFAULT_CHANNEL ?? constants.CHANNEL;
    this.currentChannel = constants.CHANNEL;
  }

  getChannel(): string {
    return this.currentChannel;
  }

  getDefaultChannel(): string {
    return this.defaultChannel;
  }

  isChannelSwitched(): boolean {
    return this.currentChannel !== this.defaultChannel;
  }

  hasInstalledBundle(bundleId: string): boolean {
    return this.lastInstalledBundleId === bundleId;
  }

  getInflightUpdate(bundleId: string): Promise<boolean> | undefined {
    return this.inflightUpdates.get(bundleId);
  }

  trackInflightUpdate(bundleId: string, promise: Promise<boolean>) {
    this.inflightUpdates.set(bundleId, promise);
  }

  clearInflightUpdate(bundleId: string) {
    this.inflightUpdates.delete(bundleId);
  }

  markBundleInstalled(bundleId: string, channel?: string) {
    this.lastInstalledBundleId = bundleId;
    if (channel) {
      this.currentChannel = channel;
    }
  }

  resetChannelState() {
    this.currentChannel = this.defaultChannel;
    this.lastInstalledBundleId = null;
    this.inflightUpdates.clear();
  }
}

const sessionState = new HotUpdaterSessionState();
let reloadBehavior: ReloadBehaviorSetting = "processRestart";
let customReloadHandler: CustomReloadHandler | null = null;

export type HotUpdaterEvent = {
  onProgress: {
    progress: number;
  };
};

const eventEmitter = new NativeEventEmitter(HotUpdaterNative);

export const addListener = <T extends keyof HotUpdaterEvent>(
  eventName: T,
  listener: (event: HotUpdaterEvent[T]) => void,
) => {
  const subscription = eventEmitter.addListener(eventName, listener);

  return () => {
    subscription.remove();
  };
};

export type UpdateParams = UpdateBundleParams & {
  status: UpdateStatus;
  shouldSkipCurrentBundleIdCheck?: boolean;
};

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
  if (status === "UPDATE" && sessionState.hasInstalledBundle(updateBundleId)) {
    return true;
  }

  const shouldSkipCurrentBundleIdCheck =
    typeof paramsOrBundleId === "string"
      ? false
      : paramsOrBundleId.shouldSkipCurrentBundleIdCheck === true;

  if (
    !shouldSkipCurrentBundleIdCheck &&
    status === "UPDATE" &&
    updateBundleId.localeCompare(getBundleId()) <= 0
  ) {
    throw new Error(
      "Update bundle id is not newer than the current bundle id. Preventing infinite update loop.",
    );
  }

  // In-flight guard: return the same promise if the same bundle is already updating.
  const existing = sessionState.getInflightUpdate(updateBundleId);
  if (existing) return existing;

  const targetFileUrl =
    typeof paramsOrBundleId === "string"
      ? (fileUrl ?? null)
      : paramsOrBundleId.fileUrl;

  const targetFileHash =
    typeof paramsOrBundleId === "string"
      ? undefined
      : paramsOrBundleId.fileHash;

  const targetChannel =
    typeof paramsOrBundleId === "string" ? undefined : paramsOrBundleId.channel;

  const promise = (async () => {
    try {
      const ok = await HotUpdaterNative.updateBundle({
        bundleId: updateBundleId,
        channel: targetChannel,
        fileUrl: targetFileUrl,
        fileHash: targetFileHash ?? null,
      });
      if (ok) {
        sessionState.markBundleInstalled(updateBundleId, targetChannel);
      }
      return ok;
    } finally {
      sessionState.clearInflightUpdate(updateBundleId);
    }
  })();

  sessionState.trackInflightUpdate(updateBundleId, promise);
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
 * Reloads the app using the currently configured reload behavior.
 *
 * Default behavior is `processRestart`.
 * On iOS, `processRestart` behaves like the normal React reload path.
 *
 * When `setReloadBehavior("processRestart")` is used:
 * - Android performs a cold process restart
 * - iOS keeps the same behavior as the normal React reload path
 *
 * When `setReloadBehavior("custom", handler)` is used:
 * - both Android and iOS execute the provided handler
 */
export const reload = async () => {
  if (reloadBehavior === "custom") {
    if (!customReloadHandler) {
      throw new Error(
        "[HotUpdater] setReloadBehavior('custom') requires a reload handler.",
      );
    }

    await customReloadHandler();
    return;
  }

  if (Platform.OS === "android" && reloadBehavior === "processRestart") {
    await HotUpdaterNative.reloadProcess();
    return;
  }

  await HotUpdaterNative.reload();
};

/**
 * Configures how `HotUpdater.reload()` should behave.
 *
 * This API is available on both Android and iOS so app code can stay symmetric.
 * By default, HotUpdater uses `processRestart`.
 *
 * Supported behaviors:
 * - `reload`: Uses React Native's normal in-process reload flow
 * - `processRestart`: Uses Android process restart when available; iOS keeps the same behavior as `reload`
 * - `custom`: Executes a JS callback on both platforms
 *
 * `custom` is intended for brownfield apps that need host-native coordination.
 */
export function setReloadBehavior(
  ...args:
    | [behavior: ReloadBehavior]
    | [behavior: "custom", handler: CustomReloadHandler]
): void {
  const [behavior, handler] = args;

  if (behavior === "custom") {
    if (typeof handler !== "function") {
      throw new Error(
        "[HotUpdater] setReloadBehavior('custom') requires a reload handler.",
      );
    }

    reloadBehavior = behavior;
    customReloadHandler = handler;
    return;
  }

  if (handler) {
    throw new Error(
      `[HotUpdater] setReloadBehavior('${behavior}') does not accept a custom reload handler.`,
    );
  }

  reloadBehavior = behavior;
  customReloadHandler = null;
}

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
  return sessionState.getChannel();
};

/**
 * Fetches the build-time default channel for the app.
 */
export const getDefaultChannel = (): string => {
  return sessionState.getDefaultChannel();
};

/**
 * Returns whether the app is currently using a runtime channel override.
 */
export const isChannelSwitched = (): boolean => {
  return sessionState.isChannelSwitched();
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
  const result = HotUpdaterNative.notifyAppReady({ bundleId });
  // Oldarch returns JSON string, newarch returns array
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return { status: "STABLE" };
    }
  }
  return result;
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

/**
 * Gets the base URL for the current active bundle directory.
 * Returns the file:// URL to the bundle directory without trailing slash.
 * This is used for Expo DOM components to construct full asset paths.
 *
 * @returns {string | null} Base URL string (e.g., "file:///data/.../bundle-store/abc123") or null if not available
 */
export const getBaseURL = (): string | null => {
  const result = HotUpdaterNative.getBaseURL();
  if (typeof result === "string" && result !== "") {
    return result;
  }
  return null;
};

/**
 * Clears the runtime channel override and restores the original bundle.
 */
export const resetChannel = async (): Promise<boolean> => {
  if (!sessionState.isChannelSwitched()) {
    return true;
  }

  const ok = await HotUpdaterNative.resetChannel();
  if (ok) {
    sessionState.resetChannelState();
  }
  return ok;
};
