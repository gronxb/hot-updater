import { Platform } from "react-native";
import { HotUpdaterError } from "./error";
import { fetchUpdateInfo } from "./fetchUpdateInfo";
import {
  getAppVersion,
  getBundleId,
  getChannel,
  getMinBundleId,
} from "./native";

export interface CheckForUpdateOptions {
  source: string;
  requestHeaders?: Record<string, string>;
  onError?: (error: Error) => void;
}

export async function checkForUpdate(options: CheckForUpdateOptions) {
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
  const currentBundleId = getBundleId();
  const minBundleId = getMinBundleId();
  const channel = getChannel();

  if (!currentAppVersion) {
    throw new HotUpdaterError("Failed to get app version");
  }

  return fetchUpdateInfo(
    options.source,
    {
      appVersion: currentAppVersion,
      bundleId: currentBundleId,
      platform,
      minBundleId,
      channel,
    },
    options.requestHeaders,
    options.onError,
  );
}
