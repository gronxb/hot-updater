import type { AppUpdateInfo, UpdateBundleParams } from "@hot-updater/core";
import { Platform } from "react-native";
import { HotUpdaterError } from "./error";
import { fetchUpdateInfo } from "./fetchUpdateInfo";
import {
  getAppVersion,
  getBundleId,
  getChannel,
  getFingerprintHash,
  getMinBundleId,
  updateBundle,
} from "./native";

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

// Internal type that includes baseURL for use within index.ts
export interface InternalCheckForUpdateOptions extends CheckForUpdateOptions {
  baseURL: string;
}

// Internal function to build update URL (not exported)
function buildUpdateUrl(
  baseURL: string,
  updateStrategy: "appVersion" | "fingerprint",
  params: UpdateBundleParams,
): string {
  switch (updateStrategy) {
    case "fingerprint": {
      if (!params.fingerprintHash) {
        throw new HotUpdaterError("Fingerprint hash is required");
      }
      return `${baseURL}/fingerprint/${params.platform}/${params.fingerprintHash}/${params.channel}/${params.minBundleId}/${params.bundleId}`;
    }
    case "appVersion": {
      return `${baseURL}/app-version/${params.platform}/${params.appVersion}/${params.channel}/${params.minBundleId}/${params.bundleId}`;
    }
  }
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

  if (!options.baseURL || !options.updateStrategy) {
    options.onError?.(
      new HotUpdaterError("'baseURL' and 'updateStrategy' are required"),
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

  const url = buildUpdateUrl(options.baseURL, options.updateStrategy, {
    platform,
    appVersion: currentAppVersion,
    fingerprintHash: fingerprintHash ?? null,
    channel,
    minBundleId,
    bundleId: currentBundleId,
  });

  return fetchUpdateInfo({
    url,
    requestHeaders: options.requestHeaders,
    onError: options.onError,
    requestTimeout: options.requestTimeout,
  }).then((updateInfo) => {
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
  });
}
