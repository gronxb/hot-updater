import { NativeModules, Platform } from "react-native";

const { HotUpdater } = NativeModules;

/**
 * Retrieves the bundle URL.
 *
 * @returns {Promise<string>} A promise that resolves to the bundle URL.
 */
export const getBundleURL = () => {
  return new Promise<string>((resolve) =>
    HotUpdater.getBundleURL((url: string) => resolve(url))
  );
};

/**
 * Sets the bundle URL.
 *
 * @param {string} url - The URL to be set as the bundle URL.
 * @returns {void} No return value.
 */
export const setBundleURL = (url: string) => {
  return HotUpdater.setBundleURL(url);
};

/**
 * Downloads and saves data from the given URL.
 *
 * @param {string} url - The URL to download data from.
 * @returns {Promise<boolean>} Resolves with `true` if the operation is successful, otherwise rejects with `false`.
 *
 */
export const downloadAndSave = (url: string) => {
  return new Promise<boolean>((resolve, reject) =>
    HotUpdater.downloadAndSave(url, (isSuccess: boolean) =>
      isSuccess ? resolve(true) : reject(false)
    )
  );
};

export interface HotUpdaterInit {
  api: {
    ios: string;
    android: string;
  };
}

export const init = async ({ api }: HotUpdaterInit) => {
  if (!["ios", "android"].includes(Platform.OS)) {
    throw new Error("HotUpdater is only supported on iOS and Android");
  }

  const url = Platform.select({
    ios: api.ios,
    android: api.android,
  })!;

  setBundleURL(url);
};
