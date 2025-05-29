import type { UpdateStatus, UpdateStrategy } from "@hot-updater/core";
import { NativeEventEmitter, Platform } from "react-native";
import HotUpdaterNative, {
  type UpdateBundleParams,
} from "./specs/NativeHotUpdater";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

declare const __HOT_UPDATER_BUNDLE_ID: string | undefined;
declare const __HOT_UPDATER_FINGERPRINT_HASH_IOS: string | null;
declare const __HOT_UPDATER_FINGERPRINT_HASH_ANDROID: string | null;
declare const __HOT_UPDATER_UPDATE_STRATEGY: UpdateStrategy;
declare const __HOT_UPDATER_CHANNEL: string | null;

export const HotUpdaterConstants = {
  OVER_THE_AIR_CHANNEL: __HOT_UPDATER_CHANNEL,
  HOT_UPDATER_BUNDLE_ID: __HOT_UPDATER_BUNDLE_ID || NIL_UUID,
  FINGERPRINT_HASH: Platform.select({
    ios: __HOT_UPDATER_FINGERPRINT_HASH_IOS,
    android: __HOT_UPDATER_FINGERPRINT_HASH_ANDROID,
    default: null,
  }),
  UPDATE_STRATEGY: __HOT_UPDATER_UPDATE_STRATEGY,
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

/**
 * Downloads files and applies them to the app.
 *
 * @param {UpdateParams} params - Parameters object required for bundle update
 * @returns {Promise<boolean>} Resolves with true if download was successful, otherwise rejects with an error.
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

  if (typeof paramsOrBundleId === "string") {
    return HotUpdaterNative.updateBundle({
      bundleId: updateBundleId,
      fileUrl: fileUrl || null,
    });
  }
  return HotUpdaterNative.updateBundle({
    bundleId: updateBundleId,
    fileUrl: paramsOrBundleId.fileUrl,
  });
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
export const reload = () => {
  requestAnimationFrame(() => {
    HotUpdaterNative.reload();
  });
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
 * @returns {Promise<string>} Resolves with the current version id or null if not available.
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
  if (HotUpdaterConstants.OVER_THE_AIR_CHANNEL) {
    return HotUpdaterConstants.OVER_THE_AIR_CHANNEL;
  }
  const constants = HotUpdaterNative.getConstants();
  return constants.CHANNEL;
};

export const getReleaseChannel = (): string => {
  const constants = HotUpdaterNative.getConstants();
  return constants.CHANNEL;
};

/**
 * Fetches the fingerprint for the app.
 *
 * @returns {string | null} Resolves with the fingerprint hash
 */
export const getFingerprintHash = (): string | null => {
  return HotUpdaterConstants.FINGERPRINT_HASH;
};
