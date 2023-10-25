import { NativeModules } from "react-native";

const { LiveUpdater } = NativeModules;

/**
 * Retrieves the bundle URL.
 *
 * @returns {Promise<string>} A promise that resolves to the bundle URL.
 */
export const getBundleURL = () => {
  return new Promise<string>((resolve) =>
    LiveUpdater.getBundleURL((url: string) => resolve(url))
  );
};

/**
 * Sets the bundle URL.
 *
 * @param {string} url - The URL to be set as the bundle URL.
 * @returns {void} No return value.
 */
export const setBundleURL = (url: string) => {
  return LiveUpdater.setBundleURL(url);
};
