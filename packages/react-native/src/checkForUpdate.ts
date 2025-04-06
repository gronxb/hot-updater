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
    options.onError?.(
      new HotUpdaterError("HotUpdater is only supported on iOS and Android"),
    );
    return null;
  }

  const currentAppVersion = await getAppVersion();
  const platform = Platform.OS as "ios" | "android";
  const currentBundleId = getBundleId();
  const minBundleId = getMinBundleId();
  const channel = getChannel();

  if (!currentAppVersion) {
    options.onError?.(new HotUpdaterError("Failed to get app version"));
    return null;
  }

  return fetchUpdateInfo(
    options.source,
    {
      appVersion: currentAppVersion,
      bundleId: currentBundleId,
      platform,
      minBundleId,
      channel: channel ?? undefined,
    },
    options.requestHeaders,
    options.onError,
  );
}
