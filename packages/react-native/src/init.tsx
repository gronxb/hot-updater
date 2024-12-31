import type { BundleArg, UpdateInfo } from "@hot-updater/core";
import { getUpdateInfo } from "@hot-updater/js";
import { Platform } from "react-native";
import { ensureBundles } from "./ensureBundles";
import { HotUpdaterError } from "./error";
import { getAppVersion, getBundleId, reload, updateBundle } from "./native";

export type HotUpdaterStatus = "INSTALLING_UPDATE" | "UP_TO_DATE";

export interface HotUpdaterInitConfig {
  source: BundleArg;
  requestHeaders?: Record<string, string>;
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

  const currentAppVersion = await getAppVersion();
  const platform = Platform.OS as "ios" | "android";
  const currentBundleId = await getBundleId();

  if (!currentAppVersion) {
    const error = new HotUpdaterError("Failed to get app version");
    config?.onError?.(error);
    throw error;
  }

  const bundles = await ensureBundles(
    config.source,
    {
      appVersion: currentAppVersion,
      bundleId: currentBundleId,
      platform,
    },
    config.requestHeaders,
  );

  let updateInfo: UpdateInfo | null = null;
  if (Array.isArray(bundles)) {
    // Direct comparison
    updateInfo = await getUpdateInfo(bundles, {
      appVersion: currentAppVersion,
      bundleId: currentBundleId,
      platform,
    });
  } else {
    // Already verified from server
    updateInfo = bundles;
  }

  if (!updateInfo) {
    config?.onSuccess?.("UP_TO_DATE");
    return;
  }

  try {
    const isSuccess = await updateBundle(
      updateInfo.id,
      updateInfo.fileUrl || "",
    );
    if (isSuccess && updateInfo.forceUpdate) {
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
