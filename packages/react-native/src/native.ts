import { NativeEventEmitter } from "react-native";
import type { UpdateBundleParams } from "./specs/NativeHotUpdater";
import HotUpdaterNative from "./specs/NativeHotUpdater";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

declare const __HOT_UPDATER_BUNDLE_ID: string | undefined;
declare const __HOT_UPDATER_CHANNEL: string | undefined;

const HotUpdater = {
  HOT_UPDATER_BUNDLE_ID: __HOT_UPDATER_BUNDLE_ID || NIL_UUID,
  CHANNEL: __HOT_UPDATER_CHANNEL || (!__DEV__ ? "production" : null),
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

/**
 * Downloads files from given URLs.
 *
 * @param {string} bundleId - identifier for the bundle id.
 * @param {string | null} zipUrl - zip file URL. If null, it means rolling back to the built-in bundle
 * @returns {Promise<boolean>} Resolves with true if download was successful, otherwise rejects with an error.
 */
export const updateBundle = (params: UpdateBundleParams): Promise<boolean> => {
  return HotUpdaterNative.updateBundle(params);
};

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
