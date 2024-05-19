import { Platform } from "react-native";
import { HotUpdaterMetaData } from "./types";
import { HotUpdaterError } from "./error";
import { wrapNetworkError } from "./wrapNetworkError";
import { getBundleVersion, reload, updateBundle } from "./native";

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
    const {
      files,
      id,
      reloadAfterUpdate = false,
    } = typeof metadata === "function"
      ? await wrapNetworkError(metadata)
      : metadata;

    const appVersionId = await getBundleVersion();
    if (id !== appVersionId) {
      const allDownloadFiles = await updateBundle(files, id);
      if (allDownloadFiles) {
        if (reloadAfterUpdate) {
          reload();
        }
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
