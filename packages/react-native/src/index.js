import { NativeModules } from "react-native";

const { InternalCodePush } = NativeModules;

/**
 * Retrieves the bundle URL.
 *
 * @returns {Promise<string>} A promise that resolves to the bundle URL.
 */
const getBundleURL = () => {
  return InternalCodePush.getBundleURL((url) => Promise.resolve(url));
};

/**
 * Sets the bundle URL.
 *
 * @param {string} url - The URL to be set as the bundle URL.
 * @returns {void} No return value.
 */
const setBundleURL = (url) => {
  return InternalCodePush.setBundleURL(url);
};

module.exports = {
  getBundleURL,
  setBundleURL,
};
