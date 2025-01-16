import type { Bundle, BundleArg, UpdateInfo } from "@hot-updater/core";
import { getUpdateInfo } from "@hot-updater/js";
import type React from "react";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { ensureUpdateInfo } from "./ensureUpdateInfo";
import { HotUpdaterError } from "./error";
import { getAppVersion, getBundleId, reload, updateBundle } from "./native";
import { type HotUpdaterState, useHotUpdaterStore } from "./store";

export interface CheckUpdateConfig {
  source: BundleArg;
  requestHeaders?: Record<string, string>;
}

export interface HotUpdaterConfig extends CheckUpdateConfig {
  fallbackComponent?: React.FC<Pick<HotUpdaterState, "progress">>;
  onError?: (error: HotUpdaterError) => void;
  onProgress?: (progress: number) => void;
  onCheckUpdateCompleted?: ({
    isBundleUpdated,
  }: { isBundleUpdated: boolean }) => void;
}

export async function checkUpdate(config: CheckUpdateConfig) {
  if (__DEV__) {
    console.warn(
      "[HotUpdater] __DEV__ is true, HotUpdater is only supported in production",
    );
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

async function installUpdate(updateInfo: UpdateInfo) {
  const isSuccess = await updateBundle(updateInfo.id, updateInfo.fileUrl || "");

  if (isSuccess && updateInfo.forceUpdate) {
    reload();
    return true;
  }

  return isSuccess;
}

export function wrap<P>(
  config: HotUpdaterConfig,
): (WrappedComponent: React.ComponentType) => React.ComponentType<P> {
  return (WrappedComponent) => {
    const HotUpdaterHOC: React.FC<P> = () => {
      const { progress, isBundleUpdated } = useHotUpdaterStore();
      const [isUpdating, setIsUpdating] = useState(false);

      useEffect(() => {
        config.onProgress?.(progress);
      }, [progress]);

      useEffect(() => {
        const initHotUpdater = async () => {
          try {
            const updateInfo = await checkUpdate(config);
            if (!updateInfo) {
              config.onCheckUpdateCompleted?.({ isBundleUpdated: false });
              return;
            }
            setIsUpdating(true);

            const isSuccess = await installUpdate(updateInfo);
            config.onCheckUpdateCompleted?.({ isBundleUpdated: isSuccess });
            setIsUpdating(false);
          } catch (error) {
            if (error instanceof HotUpdaterError) {
              config.onError?.(error);
            }
            setIsUpdating(false);
            throw error;
          }
        };

        initHotUpdater();
      }, [config.source, config.requestHeaders]);

      if (config.fallbackComponent && isUpdating) {
        const Fallback = config.fallbackComponent;
        return <Fallback progress={progress} />;
      }

      return <WrappedComponent />;
    };

    return HotUpdaterHOC;
  };
}
