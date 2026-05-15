import React, { useEffect, useState } from "react";

import { checkForUpdate } from "./checkForUpdate";
import type { HotUpdaterError } from "./error";
import { useEventCallback } from "./hooks/useEventCallback";
import {
  getBundleId,
  type NotifyAppReadyResult,
  notifyAppReady as nativeNotifyAppReady,
  reload,
} from "./native";
import { type HotUpdaterState, useHotUpdaterStore } from "./store";
import type { HotUpdaterBaseURL, HotUpdaterResolver } from "./types";

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

export type HotUpdaterFallbackComponentProps = {
  status: Exclude<UpdateStatus, "UPDATE_PROCESS_COMPLETED">;
  progress: number;
  downloadedBytes: HotUpdaterState["downloadedBytes"];
  totalBytes: HotUpdaterState["totalBytes"];
  message: string | null;
  artifactType: HotUpdaterState["artifactType"];
  details: HotUpdaterState["details"];
};

/**
 * Common options shared by HotUpdater initialization APIs.
 */
interface CommonHotUpdaterOptions {
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
   * Callback invoked when the app is ready and the native launch report is available.
   * Provides information about rollback recovery or stable state.
   *
   * @param result - Bundle state information
   * @param result.status - Current bundle state:
   *   - "RECOVERED": App recovered from a crash, rollback occurred
   *   - "STABLE": No changes, bundle is stable
   * @param result.crashedBundleId - Present only when status is "RECOVERED"
   *
   * @example
   * ```tsx
   * HotUpdater.init({
   *   baseURL: "https://api.example.com",
   *   onNotifyAppReady: ({ status, crashedBundleId }) => {
   *     if (status === "RECOVERED") {
   *       analytics.track("bundle_rollback", { crashedBundleId });
   *     }
   *   },
   * });
   * ```
   */
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
}

/**
 * Configuration with baseURL for standard server-based updates
 */
interface BaseURLConfig {
  /**
   * Base URL for update server. Use a function to resolve it dynamically
   * before each update check.
   * @example "https://update.example.com"
   * @example () => getUpdateServerURL()
   */
  baseURL: HotUpdaterBaseURL;

  /**
   * Resolver is not allowed when using baseURL
   */
  resolver?: never;
}

/**
 * Configuration with resolver for custom network operations
 */
interface ResolverConfig {
  /**
   * Custom resolver for network operations
   */
  resolver: HotUpdaterResolver;

  /**
   * baseURL is not allowed when using resolver
   */
  baseURL?: never;
}

/**
 * Union type ensuring baseURL and resolver are mutually exclusive
 */
type NetworkConfig = BaseURLConfig | ResolverConfig;

export type AutoUpdateOptions = CommonHotUpdaterOptions &
  NetworkConfig & {
    updateMode?: never;

    /**
     * Update strategy
     * - "fingerprint": Use fingerprint hash to check for updates
     * - "appVersion": Use app version to check for updates
     */
    updateStrategy: "fingerprint" | "appVersion";

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
    fallbackComponent?: React.FC<HotUpdaterFallbackComponentProps>;

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
  };

export type ManualUpdateOptions = CommonHotUpdaterOptions &
  NetworkConfig & {
    /**
     * @deprecated `HotUpdater.wrap({ updateMode: "manual" })` is deprecated.
     * Use `HotUpdater.init(...)`, export your root component directly, and call
     * `HotUpdater.checkForUpdate(...)` when your manual flow needs it.
     */
    updateMode: "manual";
  };

export type HotUpdaterInitOptions = CommonHotUpdaterOptions & NetworkConfig;

export type HotUpdaterOptions = AutoUpdateOptions | ManualUpdateOptions;

/**
 * Internal options after normalization in index.ts
 * Always has resolver (never baseURL)
 */
type InternalCommonOptions = {
  resolver: HotUpdaterResolver;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
};

type InternalAutoUpdateOptions = InternalCommonOptions & {
  updateStrategy: "fingerprint" | "appVersion";
  updateMode: "auto";
  onError?: (error: HotUpdaterError | Error | unknown) => void;
  fallbackComponent?: React.FC<HotUpdaterFallbackComponentProps>;
  onProgress?: (progress: number) => void;
  reloadOnForceUpdate?: boolean;
  onUpdateProcessCompleted?: (response: RunUpdateProcessResponse) => void;
};

type InternalManualUpdateOptions = InternalCommonOptions & {
  updateMode: "manual";
};

export type InternalInitOptions = InternalCommonOptions;

export type InternalWrapOptions =
  | InternalAutoUpdateOptions
  | InternalManualUpdateOptions;

type RequestAnimationFrame = (callback: (timestamp: number) => void) => number;

let didWarnManualWrapDeprecation = false;

const warnManualWrapDeprecation = () => {
  if (didWarnManualWrapDeprecation) {
    return;
  }

  didWarnManualWrapDeprecation = true;
  console.warn(
    '[HotUpdater] HotUpdater.wrap({ updateMode: "manual" }) is deprecated. ' +
      "Use HotUpdater.init(...) once, export your root component directly, " +
      "and call HotUpdater.checkForUpdate(...) for manual update flows.",
  );
};

const waitForNextFrame = () =>
  new Promise<void>((resolve) => {
    const requestAnimationFrame = (
      globalThis as typeof globalThis & {
        requestAnimationFrame?: RequestAnimationFrame;
      }
    )?.requestAnimationFrame;

    if (requestAnimationFrame) {
      requestAnimationFrame(() => resolve());
      return;
    }

    void Promise.resolve().then(resolve);
  });

/**
 * Helper function to handle notifyAppReady flow
 */
const handleNotifyAppReady = async (options: {
  resolver?: HotUpdaterResolver;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
}): Promise<void> => {
  await waitForNextFrame();

  try {
    const nativeResult = nativeNotifyAppReady();

    // If resolver.notifyAppReady exists, call it with simplified params
    if (options.resolver?.notifyAppReady) {
      await options.resolver
        .notifyAppReady({
          status: nativeResult.status,
          crashedBundleId: nativeResult.crashedBundleId,
          requestHeaders: options.requestHeaders,
          requestTimeout: options.requestTimeout,
        })
        .catch((e: unknown) => {
          console.warn("[HotUpdater] Resolver notifyAppReady failed:", e);
        });
    }

    options.onNotifyAppReady?.(nativeResult);
  } catch (e) {
    console.warn("[HotUpdater] Failed to notify app ready:", e);
  }
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
          restOptions.onError?.(error);
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
