import type { UpdateSourceArg } from "@hot-updater/utils";
import { Platform } from "react-native";
import { checkForUpdate } from "./checkForUpdate";
import { HotUpdaterError } from "./error";
import { initializeOnAppUpdate, reload, updateBundle } from "./native";

export type HotUpdaterStatus = "INSTALLING_UPDATE" | "UP_TO_DATE";

export interface HotUpdaterInitConfig {
  source: UpdateSourceArg;
  onSuccess?: (status: HotUpdaterStatus) => void;
  onError?: (error: HotUpdaterError) => void;
}

export const init = async (config: HotUpdaterInitConfig) => {
  if (__DEV__) {
    console.warn(
      "[HotUpdater] __DEV__ is true, HotUpdater is only supported in production",
    );
    return;
  }

  if (!["ios", "android"].includes(Platform.OS)) {
    const error = new HotUpdaterError(
      "HotUpdater is only supported on iOS and Android",
    );

    config?.onError?.(error);
    throw error;
  }
  await initializeOnAppUpdate();

  const update = await checkForUpdate(config.source);
  if (!update) {
    config?.onSuccess?.("UP_TO_DATE");
    return;
  }

  try {
    const isSuccess = await updateBundle(update.bundleId, update.file);
    if (isSuccess && update.forceUpdate) {
      reload();

      config?.onSuccess?.("INSTALLING_UPDATE");
    }
  } catch (error) {
    if (error instanceof HotUpdaterError) {
      config?.onError?.(error);
    }
    throw error;
  }
};
