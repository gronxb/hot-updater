import { NativeModules, Platform } from "react-native";
import { NIL_UUID } from "./const";

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

const HotUpdater = HotUpdaterModule
  ? HotUpdaterModule
  : new Proxy(
      {},
      {
        get() {
          throw new Error(LINKING_ERROR);
        },
      },
    );

/**
 * Fetches the current bundle version id.
 *
 * @async
 * @returns {Promise<string>} Resolves with the current version id or null if not available.
 */
export const getBundleId = (): string => {
  return HotUpdater.HOT_UPDATER_BUNDLE_ID ?? NIL_UUID;
};

/**
 * Downloads files from given URLs.
 *
 * @async
 * @param {string} bundleId - identifier for the bundle version.
 * @param {string | null} zipUrl - zip file URL.
 * @returns {Promise<boolean>} Resolves with true if download was successful, otherwise rejects with an error.
 */
export const updateBundle = (
  bundleId: string,
  zipUrl: string | null,
): Promise<boolean> => {
  return HotUpdater.updateBundle(bundleId, zipUrl);
};

/**
 * Fetches the current app version.
 */
export const getAppVersion = (): Promise<string | null> => {
  return HotUpdater.getAppVersion();
};

/**
 * Reloads the app.
 */
export const reload = () => {
  HotUpdater.reload();
};
