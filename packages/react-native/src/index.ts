import { NativeModules, Platform } from "react-native";
import { HotUpdaterMetaData } from "./types";

const { HotUpdater } = NativeModules;

/**
 * Fetches the current app version id.
 *
 * @async
 * @returns {Promise<string|null>} Resolves with the current version id or null if not available.
 * @throws {Error} Rejects if there's an error while fetching the version id.
 */
export const getAppVersionId = async (): Promise<string | null> => {
  return new Promise((resolve) => {
    HotUpdater.getAppVersionId((version: string | null) => {
      resolve(version);
    });
  });
};

/**
 * Downloads files from given URLs.
 *
 * @async
 * @param {string[]} urlStrings - An array of URL strings to download files from.
 * @param {string} prefix - The prefix to be added to each file name.
 * @returns {Promise<boolean>} Resolves with true if download was successful, otherwise rejects with an error.
 * @throws {Error} Throws an error with message 'INVALID_URL' if any of the URL strings are invalid.
 * @throws {Error} Throws an error with message 'DOWNLOAD_ERROR' if the download fails.
 */
export const downloadFilesFromURLs = (
  urlStrings: string[],
  prefix: string
): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    HotUpdater.downloadFilesFromURLs(
      urlStrings,
      prefix,
      (success: boolean) => {
        resolve(success);
      },
      (_: string, errorMessage: string) => {
        reject(new Error(errorMessage));
      }
    );
  });
};

export type HotUpdaterContext =
  | {
      ios: string;
      android: string;
    }
  | string;

export interface HotUpdaterInit {
  metadata:
    | HotUpdaterMetaData
    | (() => HotUpdaterMetaData)
    | (() => Promise<HotUpdaterMetaData>);
}

export const init = async ({ metadata }: HotUpdaterInit) => {
  if (!["ios", "android"].includes(Platform.OS)) {
    throw new Error("HotUpdater is only supported on iOS and Android");
  }

  const { files, id } =
    typeof metadata === "function" ? await metadata() : metadata;

  const appVersionId = await getAppVersionId();
  if (id !== appVersionId && id != null) {
    await downloadFilesFromURLs(files, id);
  }
};
