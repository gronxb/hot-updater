import { NativeModules } from "react-native";

const { InternalCodePush } = NativeModules;

/**
 * Retrieves the bundle URL.
 *
 * @returns {Promise<string>} A promise that resolves to the bundle URL.
 */
export const getBundleURL = (): Promise<string> => {
  return InternalCodePush.getBundleURL((url: string) => Promise.resolve(url));
};

/**
 * Sets the bundle URL.
 *
 * @param {string} url - The URL to be set as the bundle URL.
 * @returns {void} No return value.
 */
export const setBundleURL = (url: string) => {
  return InternalCodePush.setBundleURL(url);
};
