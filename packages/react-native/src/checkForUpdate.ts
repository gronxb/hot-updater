import type { AppUpdateInfo } from "@hot-updater/core";
import { Platform } from "react-native";
import { HotUpdaterError } from "./error";
import {
  getAppVersion,
  getBundleId,
  getChannel,
  getFingerprintHash,
  getMinBundleId,
  updateBundle,
} from "./native";
import type { HotUpdaterResolver } from "./types";

export interface CheckForUpdateOptions {
  /**
   * Update strategy
   * - "fingerprint": Use fingerprint hash to check for updates
   * - "appVersion": Use app version to check for updates
   * - Can override the strategy set in HotUpdater.wrap()
   */
  updateStrategy: "appVersion" | "fingerprint";

  requestHeaders?: Record<string, string>;
  onError?: (error: Error) => void;
  /**
   * The timeout duration for the request.
   * @default 5000
   */
  requestTimeout?: number;
}

export type CheckForUpdateResult = AppUpdateInfo & {
  /**
   * Updates the bundle.
   * This method is equivalent to `HotUpdater.updateBundle()` but with all required arguments pre-filled.
   */
  updateBundle: () => Promise<boolean>;
};

// Internal type that includes resolver for use within index.ts
export interface InternalCheckForUpdateOptions extends CheckForUpdateOptions {
  resolver: HotUpdaterResolver;
}

export async function checkForUpdate(
  options: InternalCheckForUpdateOptions,
): Promise<CheckForUpdateResult | null> {
  if (__DEV__) {
    return null;
  }

  if (!["ios", "android"].includes(Platform.OS)) {
    options.onError?.(
      new HotUpdaterError("HotUpdater is only supported on iOS and Android"),
    );
    return null;
  }

  const currentAppVersion = getAppVersion();
  const platform = Platform.OS as "ios" | "android";
  const currentBundleId = getBundleId();
  const minBundleId = getMinBundleId();
  const channel = getChannel();

  if (!currentAppVersion) {
    options.onError?.(new HotUpdaterError("Failed to get app version"));
    return null;
  }

  const fingerprintHash = getFingerprintHash();

  if (!options.resolver?.checkUpdate) {
    options.onError?.(
      new HotUpdaterError("Resolver is required but not configured"),
    );
    return null;
  }

  let updateInfo: AppUpdateInfo | null = null;

  try {
    updateInfo = await options.resolver.checkUpdate({
      platform,
      appVersion: currentAppVersion,
      bundleId: currentBundleId,
      minBundleId,
      channel,
      updateStrategy: options.updateStrategy,
      fingerprintHash,
      requestHeaders: options.requestHeaders,
      requestTimeout: options.requestTimeout,
    });
  } catch (error) {
    options.onError?.(error as Error);
    return null;
  }

  if (!updateInfo) {
    return null;
  }

  return {
    ...updateInfo,
    updateBundle: async () => {
      return updateBundle({
        bundleId: updateInfo.id,
        fileUrl: updateInfo.fileUrl,
        fileHash: updateInfo.fileHash,
        status: updateInfo.status,
      });
    },
  };
}
