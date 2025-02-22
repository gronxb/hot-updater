import type { Bundle, BundleArg, UpdateInfo } from "@hot-updater/core";
import { getUpdateInfo } from "@hot-updater/js";
import { Platform } from "react-native";
import { ensureUpdateInfo } from "./ensureUpdateInfo";
import { HotUpdaterError } from "./error";
import { getAppVersion, getBundleId } from "./native";

export interface CheckForUpdateConfig {
  source: BundleArg;
  requestHeaders?: Record<string, string>;
}

export async function checkForUpdate(config: CheckForUpdateConfig) {
  if (__DEV__) {
    return null;
  }

  if (!["ios", "android"].includes(Platform.OS)) {
    throw new HotUpdaterError(
      "HotUpdater is only supported on iOS and Android",
    );
  }

  const currentAppVersion = await getAppVersion();
  const platform = Platform.OS as "ios" | "android";
  const currentBundleId = await getBundleId();

  if (!currentAppVersion) {
    throw new HotUpdaterError("Failed to get app version");
  }

  const ensuredUpdateInfo = await ensureUpdateInfo(
    config.source,
    {
      appVersion: currentAppVersion,
      bundleId: currentBundleId,
      platform,
    },
    config.requestHeaders,
  );

  let updateInfo: UpdateInfo | null = null;
  if (Array.isArray(ensuredUpdateInfo)) {
    const bundles: Bundle[] = ensuredUpdateInfo;

    updateInfo = await getUpdateInfo(bundles, {
      appVersion: currentAppVersion,
      bundleId: currentBundleId,
      platform,
    });
  } else {
    updateInfo = ensuredUpdateInfo;
  }

  return updateInfo;
}
