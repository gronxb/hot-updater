import type { Bundle, BundleArg, UpdateInfo } from "@hot-updater/core";
import { getUpdateInfo } from "@hot-updater/js";
import type React from "react";
import { useEffect, useState } from "react";
import {} from "react-native";
import { Platform } from "react-native";
import { ensureUpdateInfo } from "./ensureUpdateInfo";
import { HotUpdaterError } from "./error";
import { getAppVersion, getBundleId, reload, updateBundle } from "./native";
import { useHotUpdaterStore } from "./store";

export type HotUpdaterStatus = "INSTALLING_UPDATE" | "UP_TO_DATE" | "UPDATING";

export interface CheckUpdateConfig {
  source: BundleArg;
  requestHeaders?: Record<string, string>;
}

export interface HotUpdaterConfig extends CheckUpdateConfig {
  fallbackComponent?: React.FC<HotUpdaterFallbackProps>;
}

export interface HotUpdaterFallbackProps {
  progress: number;
}

export interface WithHotUpdaterProps {
  updateStatus: HotUpdaterStatus | null;
  updateError: HotUpdaterError | null;
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
): (
  WrappedComponent: React.ComponentType<P & WithHotUpdaterProps>,
) => React.ComponentType<P> {
  return (WrappedComponent) => {
    const HotUpdaterHOC: React.FC<P> = (props) => {
      const [updateStatus, setUpdateStatus] = useState<HotUpdaterStatus | null>(
        null,
      );
      const [updateError, setUpdateError] = useState<HotUpdaterError | null>(
        null,
      );

      const { progress } = useHotUpdaterStore();

      useEffect(() => {
        const initHotUpdater = async () => {
          try {
            const updateInfo = await checkUpdate(config);

            if (!updateInfo) {
              setUpdateStatus("UP_TO_DATE");
              return;
            }

            setUpdateStatus("UPDATING");
            const isSuccess = await installUpdate(updateInfo);
            if (isSuccess) {
              setUpdateStatus("INSTALLING_UPDATE");
            }
          } catch (error) {
            if (error instanceof HotUpdaterError) {
              setUpdateError(error);
            }
            throw error;
          }
        };

        initHotUpdater();
      }, [config.source, config.requestHeaders]);

      if (updateStatus === "UPDATING" && config.fallbackComponent) {
        const Fallback = config.fallbackComponent;
        return <Fallback progress={progress} />;
      }

      return (
        <WrappedComponent
          {...props}
          updateStatus={updateStatus}
          updateError={updateError}
        />
      );
    };

    return HotUpdaterHOC;
  };
}
