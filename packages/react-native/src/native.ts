import type { UpdateStatus } from "@hot-updater/core";
import { NativeEventEmitter } from "react-native";
import HotUpdaterNative, {
  type UpdateBundleParams,
} from "./specs/NativeHotUpdater";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

declare const __HOT_UPDATER_BUNDLE_ID: string | undefined;
declare const __HOT_UPDATER_CHANNEL: string | undefined;
declare const __HOT_UPDATER_FINGERPRINT: string;

const HotUpdater = {
  HOT_UPDATER_BUNDLE_ID: __HOT_UPDATER_BUNDLE_ID || NIL_UUID,
  CHANNEL: __HOT_UPDATER_CHANNEL || (!__DEV__ ? "production" : null),
  FINGERPRINT: __HOT_UPDATER_FINGERPRINT,
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
  return HotUpdater.HOT_UPDATER_BUNDLE_ID === NIL_UUID
    ? getMinBundleId()
    : HotUpdater.HOT_UPDATER_BUNDLE_ID;
};

/**
 * Sets the channel for the app.
 */
export const setChannel = async (channel: string) => {
  return HotUpdaterNative.setChannel(channel);
};

export const getChannel = (): string | null => {
  const constants = HotUpdaterNative.getConstants();
  return constants?.CHANNEL ?? HotUpdater.CHANNEL ?? null;
};

/**
 * Fetches the fingerprint for the app.
 *
 * @returns {string} Resolves with the fingerprint.
 */
export const getFingerprint = (): string => {
  return HotUpdater.FINGERPRINT;
};
