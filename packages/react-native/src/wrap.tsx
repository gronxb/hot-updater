import type { UpdateInfo } from "@hot-updater/core";
import type React from "react";
import { useEffect, useState } from "react";
import { type CheckForUpdateConfig, checkForUpdate } from "./checkUpdate";
import { HotUpdaterError } from "./error";
import { reload, updateBundle } from "./native";
import { type HotUpdaterState, useHotUpdaterStore } from "./store";

export interface HotUpdaterConfig extends CheckForUpdateConfig {
  fallbackComponent?: React.FC<Pick<HotUpdaterState, "progress">>;
  onError?: (error: HotUpdaterError) => void;
  onProgress?: (progress: number) => void;
  onCheckUpdateCompleted?: ({
    isBundleUpdated,
  }: { isBundleUpdated: boolean }) => void;
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
      const { progress } = useHotUpdaterStore();
      const [isCheckUpdateCompleted, setIsCheckUpdateCompleted] =
        useState(false);

      useEffect(() => {
        config.onProgress?.(progress);
      }, [progress]);

      useEffect(() => {
        const initHotUpdater = async () => {
          try {
            const updateInfo = await checkForUpdate(config);
            if (!updateInfo) {
              config.onCheckUpdateCompleted?.({ isBundleUpdated: false });
              setIsCheckUpdateCompleted(true);
              return;
            }

            const isSuccess = await installUpdate(updateInfo);
            config.onCheckUpdateCompleted?.({ isBundleUpdated: isSuccess });
            setIsCheckUpdateCompleted(true);
          } catch (error) {
            if (error instanceof HotUpdaterError) {
              config.onError?.(error);
            }
            setIsCheckUpdateCompleted(true);
            throw error;
          }
        };

        initHotUpdater();
      }, [config.source, config.requestHeaders]);

      if (
        config.fallbackComponent &&
        !isCheckUpdateCompleted &&
        progress > 0 &&
        progress < 1
      ) {
        const Fallback = config.fallbackComponent;
        return <Fallback progress={progress} />;
      }

      return <WrappedComponent />;
    };

    return HotUpdaterHOC;
  };
}
