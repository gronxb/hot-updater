import { NativeModules, Platform } from "react-native";
import { HotUpdaterMetaData } from "./types";

const { HotUpdater } = NativeModules;

/**
 * Fetches the current app version id.
 *
 * @async
 * @returns {Promise<string|null>} Resolves with the current version id or null if not available.
 */
export const getAppVersionId = async (): Promise<string | null> => {
  return new Promise((resolve) => {
    HotUpdater.getAppVersionId((versionId: string | null) => {
      resolve(versionId);
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
 */
export const downloadFilesFromURLs = (
  urlStrings: string[],
  prefix: string
): Promise<boolean> => {
  return new Promise((resolve) => {
    HotUpdater.downloadFilesFromURLs(urlStrings, prefix, (success: boolean) => {
      resolve(success);
    });
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
