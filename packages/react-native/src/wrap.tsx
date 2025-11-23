import React, { useEffect, useLayoutEffect, useState } from "react";
import { type CheckForUpdateOptions, checkForUpdate } from "./checkForUpdate";
import type { HotUpdaterError } from "./error";
import { useEventCallback } from "./hooks/useEventCallback";
import { getBundleId, reload } from "./native";
import type { RunUpdateProcessResponse } from "./runUpdateProcess";
import { useHotUpdaterStore } from "./store";
import {
  extractSignatureFailure,
  isSignatureVerificationError,
  type SignatureVerificationFailure,
} from "./types";

type UpdateStatus =
  | "CHECK_FOR_UPDATE"
  | "UPDATING"
  | "UPDATE_PROCESS_COMPLETED";

export interface HotUpdaterOptions extends CheckForUpdateOptions {
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
    message: string | null;
  }>;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
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
  /**
   * Callback fired when bundle signature verification fails.
   * This is a security-critical event that indicates the bundle
   * may have been tampered with or the public key is misconfigured.
   *
   * Use this to:
   * - Show a security warning to users
   * - Report to security/analytics services
   * - Force users to update via app store
   *
   * @see {@link https://hot-updater.dev/docs/react-native-api/wrap#onsignatureverificationfailure}
   */
  onSignatureVerificationFailure?: (
    failure: SignatureVerificationFailure,
  ) => void;
}

export function wrap<P extends React.JSX.IntrinsicAttributes = object>(
  options: HotUpdaterOptions,
): (WrappedComponent: React.ComponentType<P>) => React.ComponentType<P> {
  const { reloadOnForceUpdate = true, ...restOptions } = options;

  return (WrappedComponent: React.ComponentType<P>) => {
    const HotUpdaterHOC: React.FC<P> = (props: P) => {
      const progress = useHotUpdaterStore((state) => state.progress);

      const [message, setMessage] = useState<string | null>(null);
      const [updateStatus, setUpdateStatus] =
        useState<UpdateStatus>("CHECK_FOR_UPDATE");

      const initHotUpdater = useEventCallback(async () => {
        let currentBundleId: string | undefined;
        try {
          setUpdateStatus("CHECK_FOR_UPDATE");

          const updateInfo = await checkForUpdate({
            source: restOptions.source,
            requestHeaders: restOptions.requestHeaders,
            onError: restOptions.onError,
          });

          setMessage(updateInfo?.message ?? null);
          currentBundleId = updateInfo?.id;

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
            void updateInfo.updateBundle().catch((error) => {
              if (isSignatureVerificationError(error)) {
                restOptions.onSignatureVerificationFailure?.(
                  extractSignatureFailure(error, updateInfo.id),
                );
              }
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
          if (isSignatureVerificationError(error)) {
            restOptions.onSignatureVerificationFailure?.(
              extractSignatureFailure(error, currentBundleId ?? "unknown"),
            );
          }
          restOptions.onError?.(error);
          setUpdateStatus("UPDATE_PROCESS_COMPLETED");
        }
      });

      useEffect(() => {
        restOptions.onProgress?.(progress);
      }, [progress]);

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
