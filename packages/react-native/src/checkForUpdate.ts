import type { AppUpdateInfo } from "@hot-updater/core";
import { Platform } from "react-native";

import { HotUpdaterError } from "./error";
import {
  getAppVersion,
  getBundleId,
  getChannel,
  getCohort,
  getDefaultChannel,
  getFingerprintHash,
  getMinBundleId,
  isChannelSwitched,
  resetChannel,
  updateBundle,
} from "./native";
import type { HotUpdaterResolver } from "./types";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface CheckForUpdateOptions {
  /**
   * Update strategy
   * - "fingerprint": Use fingerprint hash to check for updates
   * - "appVersion": Use app version to check for updates
   * - Can override the strategy set in HotUpdater.wrap()
   */
  updateStrategy: "appVersion" | "fingerprint";

  /**
   * Override the current channel when checking for updates.
   * The channel switch is only persisted after the returned update is applied.
   */
  channel?: string;

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

const isResetToBuiltInResponse = (updateInfo: AppUpdateInfo): boolean => {
  return (
    updateInfo.status === "ROLLBACK" &&
    updateInfo.id === NIL_UUID &&
    updateInfo.fileUrl === null
  );
};

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
  const defaultChannel = getDefaultChannel();
  const isSwitched = isChannelSwitched();
  const currentChannel = isSwitched ? getChannel() : defaultChannel;
  const explicitChannel = options.channel || undefined;
  const targetChannel = explicitChannel || currentChannel;
  const isFirstRuntimeChannelSwitchAttempt =
    !isSwitched &&
    explicitChannel !== undefined &&
    explicitChannel !== defaultChannel;
  const requestBundleId = isFirstRuntimeChannelSwitchAttempt
    ? minBundleId
    : currentBundleId;

  const cohort = getCohort();

  if (!currentAppVersion) {
    options.onError?.(new HotUpdaterError("Failed to get app version"));
    return null;
  }

  if (isSwitched && explicitChannel && explicitChannel !== currentChannel) {
    const error = new HotUpdaterError(
      `Runtime channel is already switched to "${currentChannel}". Call HotUpdater.resetChannel() before checking "${explicitChannel}".`,
    );
    options.onError?.(error);
    throw error;
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
      bundleId: requestBundleId,
      minBundleId,
      cohort,
      channel: targetChannel,
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

  if (
    explicitChannel &&
    explicitChannel !== defaultChannel &&
    !isSwitched &&
    updateInfo.status === "ROLLBACK"
  ) {
    return null;
  }

  return {
    ...updateInfo,
    updateBundle: async () => {
      if (
        explicitChannel &&
        isSwitched &&
        isResetToBuiltInResponse(updateInfo)
      ) {
        return resetChannel();
      }

      const runtimeChannel =
        updateInfo.fileUrl !== null ? targetChannel : undefined;

      return updateBundle({
        bundleId: updateInfo.id,
        channel: runtimeChannel,
        fileUrl: updateInfo.fileUrl,
        fileHash: updateInfo.fileHash,
        status: updateInfo.status,
        shouldSkipCurrentBundleIdCheck: isFirstRuntimeChannelSwitchAttempt,
      });
    },
  };
}
