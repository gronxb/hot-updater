import type { AppUpdateInfo, UpdateBundleParams } from "@hot-updater/core";
import { Platform } from "react-native";
import { HotUpdaterError } from "./error";
import { fetchUpdateInfo, type UpdateSource } from "./fetchUpdateInfo";
import {
  getAppVersion,
  getBundleId,
  getChannel,
  getFingerprintHash,
  getMinBundleId,
  updateBundle,
} from "./native";

export interface CheckForUpdateOptions {
  source: UpdateSource;
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
   * @param options - Optional configuration
   * @param options.identifier - Optional identifier to target a specific HotUpdater instance.
   *                              Use this in brownfield apps with multiple React Native views.
   */
  updateBundle: (options?: { identifier?: string }) => Promise<boolean>;
};

export async function checkForUpdate(
  options: CheckForUpdateOptions,
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

  return fetchUpdateInfo({
    source: options.source,
    params: {
      bundleId: currentBundleId,
      appVersion: currentAppVersion,
      platform,
      minBundleId,
      channel,
      fingerprintHash,
    },
    requestHeaders: options.requestHeaders,
    onError: options.onError,
    requestTimeout: options.requestTimeout,
  }).then((updateInfo) => {
    if (!updateInfo) {
      return null;
    }

    return {
      ...updateInfo,
      updateBundle: async (options) => {
        return updateBundle({
          bundleId: updateInfo.id,
          fileUrl: updateInfo.fileUrl,
          fileHash: updateInfo.fileHash,
          status: updateInfo.status,
          identifier: options?.identifier,
        });
      },
    };
  });
}

export interface GetUpdateSourceOptions {
  /**
   * The update strategy to use.
   * @description
   * - "fingerprint": Use the fingerprint hash to check for updates.
   * - "appVersion": Use the target app version to check for updates.
   */
  updateStrategy: "appVersion" | "fingerprint";
}

export const getUpdateSource =
  (baseUrl: string, options: GetUpdateSourceOptions) =>
  (params: UpdateBundleParams) => {
    switch (options.updateStrategy) {
      case "fingerprint": {
        if (!params.fingerprintHash) {
          throw new HotUpdaterError("Fingerprint hash is required");
        }
        return `${baseUrl}/fingerprint/${params.platform}/${params.fingerprintHash}/${params.channel}/${params.minBundleId}/${params.bundleId}`;
      }
      case "appVersion": {
        return `${baseUrl}/app-version/${params.platform}/${params.appVersion}/${params.channel}/${params.minBundleId}/${params.bundleId}`;
      }
      default:
        return baseUrl;
    }
  };
