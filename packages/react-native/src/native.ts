import { NativeModules, Platform } from "react-native";
import { NIL_UUID } from "./const";
import { HotUpdaterError } from "./error";

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
  return new Promise((resolve, reject) => {
    HotUpdater.updateBundle(String(bundleId), zipUrl, (success: boolean) => {
      if (success) {
        resolve(success);
      } else {
        reject(
          new HotUpdaterError("Failed to download and install the update"),
        );
      }
    });
  });
};

/**
 * Fetches the current app version.
 */
export const getAppVersion = async (): Promise<string | null> => {
  return new Promise((resolve) => {
    HotUpdater.getAppVersion((version: string | null) => {
      resolve(version);
    });
  });
};

/**
 * Reloads the app.
 */
export const reload = () => {
  HotUpdater.reload();
};
