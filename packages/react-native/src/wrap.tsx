import React, { useEffect, useLayoutEffect, useState } from "react";
import { checkForUpdate } from "./checkForUpdate";
import type { HotUpdaterError } from "./error";
import { useEventCallback } from "./hooks/useEventCallback";
import {
  getBundleId,
  type NotifyAppReadyResult,
  notifyAppReady as nativeNotifyAppReady,
  reload,
} from "./native";
import { useHotUpdaterStore } from "./store";

export interface RunUpdateProcessResponse {
  status: "ROLLBACK" | "UPDATE" | "UP_TO_DATE";
  shouldForceUpdate: boolean;
  message: string | null;
  id: string;
}

type UpdateStatus =
  | "CHECK_FOR_UPDATE"
  | "UPDATING"
  | "UPDATE_PROCESS_COMPLETED";

/**
 * Common options shared between auto and manual update modes
 */
interface CommonHotUpdaterOptions {
  /**
   * Base URL for update server
   * @example "https://update.example.com"
   */
  baseURL: string;

  /**
   * Custom request headers for update checks
   */
  requestHeaders?: Record<string, string>;

  /**
   * Request timeout in milliseconds
   * @default 5000
   */
  requestTimeout?: number;

  /**
   * Callback invoked when the app is ready and bundle verification completes.
   * Provides information about bundle promotion, recovery from crashes, or stable state.
   *
   * @param result - Bundle state information
   * @param result.status - Current bundle state:
   *   - "PROMOTED": Staging bundle was promoted to stable (new update applied)
   *   - "RECOVERED": App recovered from a crash, rollback occurred
   *   - "STABLE": No changes, bundle is stable
   * @param result.crashedBundleId - Present only when status is "RECOVERED"
   *
   * @example
   * ```tsx
   * HotUpdater.wrap({
   *   baseURL: "https://api.example.com",
   *   updateMode: "manual",
   *   onNotifyAppReady: ({ status, crashedBundleId }) => {
   *     if (status === "RECOVERED") {
   *       analytics.track('bundle_rollback', { crashedBundleId });
   *     } else if (status === "PROMOTED") {
   *       analytics.track('bundle_promoted');
   *     }
   *   }
   * })(App);
   * ```
   */
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
}

export interface AutoUpdateOptions extends CommonHotUpdaterOptions {
  /**
   * Update strategy
   * - "fingerprint": Use fingerprint hash to check for updates
   * - "appVersion": Use app version to check for updates
   */
  updateStrategy: "fingerprint" | "appVersion";

  /**
   * Update mode
   * - "auto": Automatically check and download updates
   */
  updateMode: "auto";

  onError?: (error: HotUpdaterError | Error | unknown) => void;

  /**
   * Component to show while downloading a new bundle update.
   *
   * When an update exists and the bundle is being downloaded, this component will block access
   * to the entry point and show download progress.
   *
   * @see {@link https://hot-updater.dev/docs/react-native-api/wrap#fallback-component}
   *
   * ```tsx
   * HotUpdater.wrap({
   *   baseURL: "<update-server-url>",
   *   updateStrategy: "appVersion",
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
    message: string | null;
  }>;

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
   * @see {@link https://hot-updater.dev/docs/react-native-api/wrap#onupdateprocesscompleted}
   */
  onUpdateProcessCompleted?: (response: RunUpdateProcessResponse) => void;
}

export interface ManualUpdateOptions extends CommonHotUpdaterOptions {
  /**
   * Update mode
   * - "manual": Only notify app ready, user manually calls checkForUpdate()
   */
  updateMode: "manual";
}

export type HotUpdaterOptions = AutoUpdateOptions | ManualUpdateOptions;

export function wrap<P extends React.JSX.IntrinsicAttributes = object>(
  options: HotUpdaterOptions,
): (WrappedComponent: React.ComponentType<P>) => React.ComponentType<P> {
  if (options.updateMode === "manual") {
    return (WrappedComponent: React.ComponentType<P>) => {
      const ManualHOC: React.FC<P> = (props: P) => {
        useLayoutEffect(() => {
          try {
            const result = nativeNotifyAppReady();
            options.onNotifyAppReady?.(result);
          } catch (e) {
            console.warn("[HotUpdater] Failed to notify app ready:", e);
          }
        }, []);

        return <WrappedComponent {...props} />;
      };

      return ManualHOC as React.ComponentType<P>;
    };
  }

  // updateMode: "auto"
  const { reloadOnForceUpdate = true, ...restOptions } = options;

  return (WrappedComponent: React.ComponentType<P>) => {
    const HotUpdaterHOC: React.FC<P> = (props: P) => {
      const progress = useHotUpdaterStore((state) => state.progress);

      const [message, setMessage] = useState<string | null>(null);
      const [updateStatus, setUpdateStatus] =
        useState<UpdateStatus>("CHECK_FOR_UPDATE");

      const initHotUpdater = useEventCallback(async () => {
        try {
          setUpdateStatus("CHECK_FOR_UPDATE");

          const updateInfo = await checkForUpdate({
            baseURL: restOptions.baseURL,
            updateStrategy: restOptions.updateStrategy,
            requestHeaders: restOptions.requestHeaders,
            requestTimeout: restOptions.requestTimeout,
            onError: restOptions.onError,
          } as Parameters<typeof checkForUpdate>[0]);

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
          restOptions.onError?.(error);
          setUpdateStatus("UPDATE_PROCESS_COMPLETED");
        }
      });

      useEffect(() => {
        restOptions.onProgress?.(progress);
      }, [progress]);

      // Notify native side that app is ready (JS bundle fully loaded)
      useLayoutEffect(() => {
        try {
          const result = nativeNotifyAppReady();
          restOptions.onNotifyAppReady?.(result);
        } catch (e) {
          console.warn("[HotUpdater] Failed to notify app ready:", e);
        }
      }, []);

      // Start update check
      useLayoutEffect(() => {
        initHotUpdater();
      }, []);

      if (
        restOptions.fallbackComponent &&
        updateStatus !== "UPDATE_PROCESS_COMPLETED"
      ) {
        const Fallback = restOptions.fallbackComponent;
        return (
          <Fallback
            progress={progress}
            status={updateStatus}
            message={message}
          />
        );
      }

      return <WrappedComponent {...props} />;
    };

    return HotUpdaterHOC as React.ComponentType<P>;
  };
}
