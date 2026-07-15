import React, { useEffect, useState } from "react";
import { Platform } from "react-native";

import { checkForUpdate } from "./checkForUpdate";
import type { HotUpdaterError } from "./error";
import { useEventCallback } from "./hooks/useEventCallback";
import {
  getAppVersion,
  getBundleId,
  getChannel,
  getCohort,
  getFingerprintHash,
  getInstallId,
  getPersistedUserIdentity,
  type NotifyAppReadyAnalyticsEvent,
  type NotifyAppReadyResult,
  readNotifyAppReady,
  reload,
} from "./native";
import { type HotUpdaterState, useHotUpdaterStore } from "./store";
import type {
  HotUpdaterBaseURL,
  HotUpdaterResolver,
  ResolverNotifyAppReadyParams,
} from "./types";

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
   * Provides information about OTA transitions finalized before JS started.
   *
   * @param result - Bundle state information
   *
   * @example
   * ```tsx
   * HotUpdater.init({
   *   baseURL: "https://api.example.com",
   *   onNotifyAppReady: (result) => {
   *     if (result.status === "RECOVERED") {
   *       console.log(result.fromBundleId, result.toBundleId);
   *     }
   *   },
   * });
   * ```
   */
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;

  /**
   * Default callback invoked when Hot Updater initialization or update checks
   * fail. Per-call `HotUpdater.checkForUpdate({ onError })` handlers override
   * this callback for that check.
   */
  onError?: (error: HotUpdaterError | Error | unknown) => void;
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
    /**
     * Automatic update mode. This is the default and can be omitted.
     */
    updateMode?: "auto";

    /**
     * Update strategy
     * - "fingerprint": Use fingerprint hash to check for updates
     * - "appVersion": Use app version to check for updates
     */
    updateStrategy: "fingerprint" | "appVersion";

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
     * @deprecated Replace manual `HotUpdater.wrap` with `HotUpdater.init`.
     *
     * ```tsx
     * import { HotUpdater } from "@hot-updater/react-native";
     *
     * HotUpdater.init({
     *   baseURL: "<your-update-server-url>",
     * });
     *
     * export default App;
     * ```
     *
     * Then call `HotUpdater.checkForUpdate(...)` from your manual update flow.
     * See https://hot-updater.dev/docs/guides/custom-update
     */
    updateMode: "manual";
  };

export type HotUpdaterInitOptions = CommonHotUpdaterOptions &
  NetworkConfig & {
    /**
     * Enables best-effort automatic OTA transition analytics transport.
     * Only `HotUpdater.init({ analytics: true })` owns this automatic delivery path.
     */
    analytics?: boolean;
  };

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
  onError?: (error: HotUpdaterError | Error | unknown) => void;
};

type InternalAutoUpdateOptions = InternalCommonOptions & {
  updateStrategy: "fingerprint" | "appVersion";
  updateMode: "auto";
  fallbackComponent?: React.FC<HotUpdaterFallbackComponentProps>;
  onProgress?: (progress: number) => void;
  reloadOnForceUpdate?: boolean;
  onUpdateProcessCompleted?: (response: RunUpdateProcessResponse) => void;
};

type InternalManualUpdateOptions = InternalCommonOptions & {
  updateMode: "manual";
};

export type InternalInitOptions = InternalCommonOptions & {
  analytics?: boolean;
};

export type InternalWrapOptions =
  | InternalAutoUpdateOptions
  | InternalManualUpdateOptions;

type RequestAnimationFrame = (callback: (timestamp: number) => void) => number;

let didWarnManualWrapDeprecation = false;
let didAttemptAutomaticAnalytics = false;

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

const buildNotifyAppReadyAnalyticsParams = (
  analyticsEvent: NotifyAppReadyAnalyticsEvent,
  options: {
    requestHeaders?: Record<string, string>;
    requestTimeout?: number;
  },
): ResolverNotifyAppReadyParams => {
  const appVersion = getAppVersion();

  if (!appVersion) {
    throw new Error(
      "[HotUpdater] Automatic analytics requires a non-null native app version.",
    );
  }

  const { userId, username } = getPersistedUserIdentity();

  return {
    appVersion,
    channel: getChannel(),
    cohort: getCohort(),
    fingerprintHash: getFingerprintHash(),
    fromBundleId: analyticsEvent.fromBundleId,
    installId: getInstallId(),
    platform: Platform.OS === "android" ? "android" : "ios",
    requestHeaders: options.requestHeaders,
    requestTimeout: options.requestTimeout,
    toBundleId: analyticsEvent.toBundleId,
    type: analyticsEvent.type,
    updateStrategy: analyticsEvent.updateStrategy,
    ...(userId != null ? { userId } : {}),
    ...(username != null ? { username } : {}),
  };
};

const maybeSendAutomaticAnalytics = async (
  options: {
    analytics?: boolean;
    resolver?: HotUpdaterResolver;
    requestHeaders?: Record<string, string>;
    requestTimeout?: number;
  },
  nativeResult: NotifyAppReadyResult,
  analyticsEvent: NotifyAppReadyAnalyticsEvent | null,
): Promise<void> => {
  if (!options.analytics || nativeResult.status === "UNCHANGED") {
    return;
  }

  if (didAttemptAutomaticAnalytics) {
    return;
  }

  didAttemptAutomaticAnalytics = true;

  if (!options.resolver?.notifyAppReady) {
    throw new Error(
      "[HotUpdater] Automatic analytics requires resolver.notifyAppReady().",
    );
  }

  if (!analyticsEvent) {
    throw new Error(
      "[HotUpdater] Native launch report is missing persisted transition metadata required for automatic analytics.",
    );
  }

  await options.resolver.notifyAppReady(
    buildNotifyAppReadyAnalyticsParams(analyticsEvent, options),
  );
};

/**
 * Helper function to handle notifyAppReady flow
 */
const handleNotifyAppReady = async (options: {
  analytics?: boolean;
  resolver?: HotUpdaterResolver;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
}): Promise<void> => {
  try {
    let nativeReadResult: ReturnType<typeof readNotifyAppReady>;
    do {
      await waitForNextFrame();
      nativeReadResult = readNotifyAppReady();
    } while (nativeReadResult.pending);

    const { analyticsEvent, result: nativeResult } = nativeReadResult;

    try {
      await maybeSendAutomaticAnalytics(options, nativeResult, analyticsEvent);
    } catch (error) {
      console.warn(
        "[HotUpdater] Automatic notifyAppReady analytics failed:",
        error,
      );
    }

    options.onNotifyAppReady?.(nativeResult);
  } catch (error) {
    options.onError?.(error);
    console.warn("[HotUpdater] Failed to notify app ready:", error);
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
