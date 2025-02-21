import { NativeEventEmitter, NativeModules, Platform } from "react-native";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const HotUpdater = {
  HOT_UPDATER_BUNDLE_ID: NIL_UUID,
};

const LINKING_ERROR =
  // biome-ignore lint/style/useTemplate: <explanation>
  `The package '@hot-updater/react-native' doesn't seem to be linked. Make sure: \n\n` +
  Platform.select({ ios: "- You have run 'pod install'\n", default: "" }) +
  "- You rebuilt the app after installing the package\n" +
  "- You are not using Expo Go\n";

// @ts-expect-error
const isTurboModuleEnabled = global.__turboModuleProxy != null;

const HotUpdaterModule = isTurboModuleEnabled
  ? require("./specs/NativeHotUpdater").default
  : NativeModules.HotUpdater;

const HotUpdaterNative = HotUpdaterModule
  ? HotUpdaterModule
  : new Proxy(
      {},
      {
        get() {
          throw new Error(LINKING_ERROR);
        },
      },
    );

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
export const updateBundle = (
  bundleId: string,
  zipUrl: string | null,
): Promise<boolean> => {
  return HotUpdaterNative.updateBundle(bundleId, zipUrl);
};

/**
 * Fetches the current app version.
 */
export const getAppVersion = (): Promise<string | null> => {
  return HotUpdaterNative.getAppVersion();
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
 * Fetches the current bundle version id.
 *
 * @async
 * @returns {Promise<string>} Resolves with the current version id or null if not available.
 */
export const getBundleId = (): string => {
  return HotUpdater.HOT_UPDATER_BUNDLE_ID;
};
