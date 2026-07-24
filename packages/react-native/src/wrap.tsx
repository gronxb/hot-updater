import React, { useEffect, useState } from "react";

import { checkForUpdate } from "./checkForUpdate";
import { useEventCallback } from "./hooks/useEventCallback";
import { getBundleId, reload } from "./native";
import { handleNotifyAppReady } from "./notifyAppReadyAnalytics";
import { useHotUpdaterStore } from "./store";
import type {
  InternalInitOptions,
  InternalWrapOptions,
  UpdateStatus,
} from "./wrap.types";

export type {
  AutoUpdateOptions,
  HotUpdaterFallbackComponentProps,
  HotUpdaterInitOptions,
  HotUpdaterOptions,
  InternalInitOptions,
  InternalWrapOptions,
  ManualUpdateOptions,
  RunUpdateProcessResponse,
} from "./wrap.types";

let didWarnManualWrapDeprecation = false;

const warnManualWrapDeprecation = () => {
  if (didWarnManualWrapDeprecation) {
    return;
  }

  didWarnManualWrapDeprecation = true;
  console.warn(
    '[HotUpdater] HotUpdater.wrap({ updateMode: "manual" }) is deprecated. ' +
      "Move the same baseURL/resolver options to HotUpdater.init({ ... }), " +
      "export your root component directly, and call " +
      "HotUpdater.checkForUpdate(...) from your manual update flow. " +
      "See https://hot-updater.dev/docs/guides/custom-update",
  );
};

export function init(options: InternalInitOptions): void {
  void handleNotifyAppReady(options);
}

export function wrap(
  options: InternalWrapOptions,
): <P extends object>(
  WrappedComponent: React.ComponentType<P>,
) => React.ComponentType<P> {
  if (options.updateMode === "manual") {
    warnManualWrapDeprecation();

    return <P extends object>(WrappedComponent: React.ComponentType<P>) => {
      const ManualHOC: React.FC<P> = (props: P) => {
        useEffect(() => {
          void handleNotifyAppReady(options);
        }, []);

        return <WrappedComponent {...props} />;
      };

      return ManualHOC as React.ComponentType<P>;
    };
  }

  const { reloadOnForceUpdate = true, ...restOptions } = options;

  return <P extends object>(WrappedComponent: React.ComponentType<P>) => {
    const HotUpdaterHOC: React.FC<P> = (props: P) => {
      const progressState = useHotUpdaterStore((state) => state);
      const progress = progressState.progress;

      const [message, setMessage] = useState<string | null>(null);
      const [updateStatus, setUpdateStatus] =
        useState<UpdateStatus>("CHECK_FOR_UPDATE");

      const initHotUpdater = useEventCallback(async () => {
        try {
          setUpdateStatus("CHECK_FOR_UPDATE");

          const updateInfo = await checkForUpdate({
            resolver: restOptions.resolver,
            updateStrategy: restOptions.updateStrategy,
            requestHeaders: restOptions.requestHeaders,
            requestTimeout: restOptions.requestTimeout,
            onError: restOptions.onError,
          });

          setMessage(updateInfo?.message ?? null);

          if (!updateInfo) {
            restOptions.onUpdateProcessCompleted?.({
              status: "UP_TO_DATE",
              shouldForceUpdate: false,
              message: null,
              id: getBundleId(),
            });
            setUpdateStatus("UPDATE_PROCESS_COMPLETED");
            return;
          }

          if (updateInfo.shouldForceUpdate === false) {
            void updateInfo.updateBundle().catch((error: unknown) => {
              restOptions.onError?.(error);
            });

            restOptions.onUpdateProcessCompleted?.({
              id: updateInfo.id,
              status: updateInfo.status,
              shouldForceUpdate: updateInfo.shouldForceUpdate,
              message: updateInfo.message,
            });
            setUpdateStatus("UPDATE_PROCESS_COMPLETED");
            return;
          }
          // Force Update Scenario
          setUpdateStatus("UPDATING");
          const isSuccess = await updateInfo.updateBundle();

          if (!isSuccess) {
            throw new Error(
              "New update was found but failed to download the bundle.",
            );
          }

          if (reloadOnForceUpdate) {
            await reload();
          }

          restOptions.onUpdateProcessCompleted?.({
            id: updateInfo.id,
            status: updateInfo.status,
            shouldForceUpdate: updateInfo.shouldForceUpdate,
            message: updateInfo.message,
          });

          setUpdateStatus("UPDATE_PROCESS_COMPLETED");
        } catch (error) {
          const normalizedError =
            error instanceof Error ? error : new Error(String(error));
          restOptions.onError?.(normalizedError);
          setUpdateStatus("UPDATE_PROCESS_COMPLETED");
        }
      });

      useEffect(() => {
        restOptions.onProgress?.(progress);
      }, [progress]);

      // Read the native launch report after the first render commit.
      useEffect(() => {
        void handleNotifyAppReady(restOptions);
      }, []);

      // Start update check
      useEffect(() => {
        initHotUpdater();
      }, []);

      if (
        restOptions.fallbackComponent &&
        updateStatus !== "UPDATE_PROCESS_COMPLETED"
      ) {
        const Fallback = restOptions.fallbackComponent;
        return (
          <Fallback
            artifactType={progressState.artifactType}
            details={progressState.details}
            downloadedBytes={progressState.downloadedBytes}
            progress={progress}
            status={updateStatus}
            message={message}
            totalBytes={progressState.totalBytes}
          />
        );
      }

      return <WrappedComponent {...props} />;
    };

    return HotUpdaterHOC as React.ComponentType<P>;
  };
}
