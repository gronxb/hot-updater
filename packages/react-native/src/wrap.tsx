import type React from "react";
import { useEffect, useLayoutEffect, useState } from "react";
import { type CheckForUpdateConfig, checkForUpdate } from "./checkForUpdate";
import { HotUpdaterError } from "./error";
import { useEventCallback } from "./hooks/useEventCallback";
import { reload, updateBundle } from "./native";
import type { RunUpdateProcessResponse } from "./runUpdateProcess";
import { useHotUpdaterStore } from "./store";

type UpdateStatus =
  | "CHECK_FOR_UPDATE"
  | "UPDATING"
  | "UPDATE_PROCESS_COMPLETED";

export interface HotUpdaterConfig extends CheckForUpdateConfig {
  /**
   * Component to show while downloading a new bundle update.
   *
   * When an update exists and the bundle is being downloaded, this component will block access
   * to the entry point and show download progress.
   *
   * @see {@link https://gronxb.github.io/hot-updater/guide/hot-updater/wrap.html#fallback-component}
   *
   * ```tsx
   * HotUpdater.wrap({
   *   source: "<update-server-url>",
   *   fallbackComponent: ({ progress = 0 }) => (
   *     <View style={styles.container}>
   *       <Text style={styles.text}>Updating... {progress}%</Text>
   *     </View>
   *   )
   * })(App)
   * ```
   *
   * If not defined, the bundle will download in the background without blocking the screen.
   */
  fallbackComponent?: React.FC<{
    status: Exclude<UpdateStatus, "UPDATE_PROCESS_COMPLETED">;
    progress: number;
  }>;
  onError?: (error: HotUpdaterError) => void;
  onProgress?: (progress: number) => void;
  /**
   * When a force update exists, the app will automatically reload.
   * If `false`, When a force update exists, the app will not reload. `shouldForceUpdate` will be returned as `true` in `onUpdateProcessCompleted`.
   * If `true`, When a force update exists, the app will automatically reload.
   * @default true
   */
  reloadOnForceUpdate?: boolean;
  /**
   * Callback function that is called when the update process is completed.
   *
   * @see {@link https://gronxb.github.io/hot-updater/guide/hot-updater/wrap.html#onupdateprocesscompleted}
   */
  onUpdateProcessCompleted?: (response: RunUpdateProcessResponse) => void;
}

export function wrap<P>(
  config: HotUpdaterConfig,
): (WrappedComponent: React.ComponentType) => React.ComponentType<P> {
  const { reloadOnForceUpdate = true, ...restConfig } = config;
  return (WrappedComponent) => {
    const HotUpdaterHOC: React.FC<P> = () => {
      const { progress } = useHotUpdaterStore();
      const [updateStatus, setUpdateStatus] =
        useState<UpdateStatus>("CHECK_FOR_UPDATE");

      const initHotUpdater = useEventCallback(async () => {
        try {
          setUpdateStatus("CHECK_FOR_UPDATE");
          const updateInfo = await checkForUpdate({
            source: restConfig.source,
            requestHeaders: restConfig.requestHeaders,
          });
          if (!updateInfo) {
            restConfig.onUpdateProcessCompleted?.({
              status: "UP_TO_DATE",
            });
            setUpdateStatus("UPDATE_PROCESS_COMPLETED");
            return;
          }

          if (updateInfo.shouldForceUpdate === false) {
            void updateBundle(updateInfo.id, updateInfo.fileUrl);
            restConfig.onUpdateProcessCompleted?.({
              id: updateInfo.id,
              status: updateInfo.status,
              shouldForceUpdate: updateInfo.shouldForceUpdate,
            });
            setUpdateStatus("UPDATE_PROCESS_COMPLETED");
            return;
          }

          // Force Update Scenario
          setUpdateStatus("UPDATING");
          const isSuccess = await updateBundle(
            updateInfo.id,
            updateInfo.fileUrl,
          );
          if (!isSuccess) {
            throw new Error(
              "New update was found but failed to download the bundle.",
            );
          }

          if (reloadOnForceUpdate) {
            reload();
          }

          restConfig.onUpdateProcessCompleted?.({
            id: updateInfo.id,
            status: updateInfo.status,
            shouldForceUpdate: updateInfo.shouldForceUpdate,
          });
          setUpdateStatus("UPDATE_PROCESS_COMPLETED");
        } catch (error) {
          if (error instanceof HotUpdaterError) {
            restConfig.onError?.(error);
          }
          setUpdateStatus("UPDATE_PROCESS_COMPLETED");
          throw error;
        }
      });

      useEffect(() => {
        restConfig.onProgress?.(progress);
      }, [progress]);

      useLayoutEffect(() => {
        initHotUpdater();
      }, []);

      if (
        restConfig.fallbackComponent &&
        updateStatus !== "UPDATE_PROCESS_COMPLETED"
      ) {
        const Fallback = restConfig.fallbackComponent;
        return <Fallback progress={progress} status={updateStatus} />;
      }

      return <WrappedComponent />;
    };

    return HotUpdaterHOC;
  };
}
