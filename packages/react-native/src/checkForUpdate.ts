import type { AppUpdateInfo } from "@hot-updater/core";
import { Platform } from "react-native";
import { HotUpdaterError } from "./error";
import {
  type IncrementalConfigInput,
  resolveIncrementalConfig,
} from "./incrementalConfig";
import {
  getAppVersion,
  getBundleId,
  getChannel,
  getFingerprintHash,
  getMinBundleId,
  updateBundle,
  updateBundleIncremental,
} from "./native";
import type {
  HotUpdaterResolver,
  IncrementalCheckResponse,
  IncrementalPayload,
  ResolverCheckUpdateResult,
} from "./types";

export interface CheckForUpdateOptions {
  /**
   * Update strategy
   * - "fingerprint": Use fingerprint hash to check for updates
   * - "appVersion": Use app version to check for updates
   * - Can override the strategy set in HotUpdater.wrap()
   */
  updateStrategy: "appVersion" | "fingerprint";

  requestHeaders?: Record<string, string>;
  incremental?: IncrementalConfigInput;
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

function normalizeUpdateInfo(
  updateInfo: ResolverCheckUpdateResult,
): { full: AppUpdateInfo; incremental: IncrementalPayload | null } | null {
  if (
    updateInfo &&
    typeof updateInfo === "object" &&
    "mode" in updateInfo &&
    typeof updateInfo.mode === "string"
  ) {
    const incrementalResponse = updateInfo as IncrementalCheckResponse;

    if (incrementalResponse.mode === "none") {
      return null;
    }

    if (incrementalResponse.mode === "full") {
      return {
        full: incrementalResponse.full,
        incremental: null,
      };
    }

    if (incrementalResponse.mode === "incremental") {
      return {
        full: incrementalResponse.full,
        incremental: incrementalResponse.incremental,
      };
    }
  }

  return {
    full: updateInfo as AppUpdateInfo,
    incremental: null,
  };
}

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
  const incrementalConfig = resolveIncrementalConfig(options.incremental);

  if (!options.resolver?.checkUpdate) {
    options.onError?.(
      new HotUpdaterError("Resolver is required but not configured"),
    );
    return null;
  }

  let updateInfo: ResolverCheckUpdateResult | null = null;

  try {
    updateInfo = await options.resolver.checkUpdate({
      platform,
      appVersion: currentAppVersion,
      bundleId: currentBundleId,
      minBundleId,
      channel,
      updateStrategy: options.updateStrategy,
      incremental: incrementalConfig.enabled,
      incrementalStrategy: incrementalConfig.strategy,
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

  const normalizedUpdateInfo = normalizeUpdateInfo(updateInfo);
  if (!normalizedUpdateInfo) {
    return null;
  }

  const { full, incremental } = normalizedUpdateInfo;

  return {
    ...full,
    updateBundle: async () => {
      if (incremental) {
        try {
          const result = await updateBundleIncremental({
            bundleId: full.id,
            baseBundleId: incremental.fromBundleId,
            contentBaseUrl: incremental.contentBaseUrl,
            jsBundlePath: incremental.jsBundlePath,
            patchHash: incremental.patch.hash,
            patchSignedHash: incremental.patch.signedHash,
            sourceHash: incremental.patch.sourceHash,
            targetHash: incremental.patch.targetHash,
            targetSignedHash: incremental.patch.targetSignedHash,
            patchStrategy: incrementalConfig.strategy,
            files: incremental.files,
          });

          if (result) {
            return true;
          }
          console.warn(
            "[HotUpdater][incremental] incremental apply returned false, falling back to full update",
          );
        } catch (error) {
          options.onError?.(error as Error);
          console.warn(
            "[HotUpdater][incremental] incremental apply failed, falling back to full update",
            error,
          );
        }
      }

      return await updateBundle({
        bundleId: full.id,
        fileUrl: full.fileUrl,
        fileHash: full.fileHash,
        status: full.status,
      });
    },
  };
}
