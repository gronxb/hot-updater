import { URL } from "react-native-url-polyfill";
import { NativeModules, Platform } from "react-native";
import { HotUpdaterMetaData } from "./types";
import { HotUpdaterError } from "./error";
import { wrapNetworkError } from "./wrapNetworkError";

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
    const encodedURLs = urlStrings.map((urlString) => {
      const url = new URL(urlString);
      return [
        url.host,
        url.pathname
          .split("/")
          .map((pathname) => encodeURIComponent(pathname))
          .join("/"),
      ].join("/");
    });

    HotUpdater.downloadFilesFromURLs(
      encodedURLs,
      prefix,
      (success: boolean) => {
        resolve(success);
      }
    );
  });
};

export type HotUpdaterStatus = "INSTALLING_UPDATE" | "UP_TO_DATE";

export interface HotUpdaterInit {
  metadata:
    | HotUpdaterMetaData
    | (() => HotUpdaterMetaData)
    | (() => Promise<HotUpdaterMetaData>);

  onSuccess?: (status: HotUpdaterStatus) => void;
  onFailure?: (e: unknown) => void;
}

export const init = async ({
  metadata,
  onSuccess,
  onFailure,
}: HotUpdaterInit) => {
  if (!["ios", "android"].includes(Platform.OS)) {
    throw new HotUpdaterError(
      "HotUpdater is only supported on iOS and Android"
    );
  }

  try {
    const { files, id } =
      typeof metadata === "function"
        ? await wrapNetworkError(metadata)
        : metadata;

    const appVersionId = await getAppVersionId();
    if (id !== appVersionId) {
      const allDownloadFiles = await downloadFilesFromURLs(files, id);
      if (allDownloadFiles) {
        onSuccess?.("INSTALLING_UPDATE");
      } else {
        throw new HotUpdaterError("HotUpdater failed to download");
      }
      return;
    }
    onSuccess?.("UP_TO_DATE");
  } catch (e) {
    if (onFailure) {
      onFailure(e);
      return;
    }
    throw e;
  }
};
