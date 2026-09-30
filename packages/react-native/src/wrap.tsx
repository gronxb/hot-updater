import React, { useEffect, useState } from "react";

import { handleNotifyAppReady } from "./appReady";
import { checkForUpdate } from "./checkForUpdate";
import { useEventCallback } from "./hooks/useEventCallback";
import { getUpdateId, reload } from "./native";
import { useHotUpdaterStore } from "./store";
import type {
  HotUpdaterFallbackComponentProps,
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
  RunUpdateProcessResponse,
} from "./wrap.types";

export function init(options: InternalInitOptions): void {
  void handleNotifyAppReady(options);
}

export function wrap(
  options: InternalWrapOptions,
): <P extends object>(
  WrappedComponent: React.ComponentType<P>,
) => React.ComponentType<P> {
  const { reloadOnForceUpdate = true, ...restOptions } = options;

  // Progress is subscribed only where it is rendered or reported, so progress
  // events don't re-render the wrapped app.
  const ProgressReporter = ({
    onProgress,
  }: {
    onProgress: (progress: number) => void;
  }) => {
    const progress = useHotUpdaterStore((state) => state.progress);

    useEffect(() => {
      onProgress(progress);
    }, [progress]);

    return null;
  };

  const FallbackWithProgress = ({
    Fallback,
    status,
    message,
  }: {
    Fallback: React.FC<HotUpdaterFallbackComponentProps>;
    status: HotUpdaterFallbackComponentProps["status"];
    message: string | null;
  }) => {
    const progressState = useHotUpdaterStore((state) => state);

    return (
      <Fallback
        artifactType={progressState.artifactType}
        details={progressState.details}
        progress={progressState.progress}
        status={status}
        message={message}
      />
    );
  };

  return <P extends object>(WrappedComponent: React.ComponentType<P>) => {
    const HotUpdaterHOC: React.FC<P> = (props: P) => {
      const [message, setMessage] = useState<string | null>(null);
      const [updateStatus, setUpdateStatus] =
        useState<UpdateStatus>("CHECK_FOR_UPDATE");

      const initHotUpdater = useEventCallback(async () => {
        try {
          setUpdateStatus("CHECK_FOR_UPDATE");

          const readiness = handleNotifyAppReady(restOptions);
          const updateInfo = await checkForUpdate({
            client: restOptions.client,
            updateStrategy: restOptions.updateStrategy,
            requestHeaders: restOptions.requestHeaders,
            requestTimeout: restOptions.requestTimeout,
            onError: restOptions.onError,
          });

          await readiness;
          setMessage(updateInfo?.message ?? null);

          if (!updateInfo) {
            restOptions.onUpdateProcessCompleted?.({
              status: "UP_TO_DATE",
              shouldForceUpdate: false,
              message: null,
              id: getUpdateId(),
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

      // Start update check
      useEffect(() => {
        initHotUpdater();
      }, []);

      const content =
        restOptions.fallbackComponent &&
        updateStatus !== "UPDATE_PROCESS_COMPLETED" ? (
          <FallbackWithProgress
            Fallback={restOptions.fallbackComponent}
            status={updateStatus}
            message={message}
          />
        ) : (
          <WrappedComponent {...props} />
        );

      if (!restOptions.onProgress) {
        return content;
      }

      return (
        <>
          {content}
          <ProgressReporter onProgress={restOptions.onProgress} />
        </>
      );
    };

    return HotUpdaterHOC as React.ComponentType<P>;
  };
}
