import { Platform } from "react-native";

import type { HotUpdaterError } from "./error";
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
} from "./native";
import type { HotUpdaterResolver, ResolverNotifyAppReadyParams } from "./types";

export type NotifyAppReadyOptions = {
  analytics?: boolean;
  resolver?: HotUpdaterResolver;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
};

type RequestAnimationFrame = (callback: (timestamp: number) => void) => number;

let didAttemptAutomaticAnalytics = false;

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

const assertNever = (value: never): never => {
  throw new Error(`[HotUpdater] Unexpected notifyAppReady status: ${value}`);
};

const buildNotifyAppReadyAnalyticsParams = (
  nativeResult: NotifyAppReadyResult,
  analyticsEvent: NotifyAppReadyAnalyticsEvent | null,
  options: Pick<NotifyAppReadyOptions, "requestHeaders" | "requestTimeout">,
): ResolverNotifyAppReadyParams => {
  const appVersion = getAppVersion();

  if (!appVersion) {
    throw new Error(
      "[HotUpdater] Automatic analytics requires a non-null native app version.",
    );
  }

  const { userId, username } = getPersistedUserIdentity();
  const installId = getInstallId();

  if (!installId) {
    throw new Error(
      "[HotUpdater] Automatic analytics requires a non-null native install id.",
    );
  }

  const platform: "ios" | "android" =
    Platform.OS === "android" ? "android" : "ios";

  const commonParams = {
    appVersion,
    channel: getChannel(),
    cohort: getCohort(),
    fingerprintHash: getFingerprintHash(),
    installId,
    platform,
    requestHeaders: options.requestHeaders,
    requestTimeout: options.requestTimeout,
    ...(userId != null ? { userId } : {}),
    ...(username != null ? { username } : {}),
  };

  switch (nativeResult.status) {
    case "UNCHANGED": {
      const bundleId = getBundleId();

      if (!bundleId) {
        throw new Error(
          "[HotUpdater] Automatic analytics requires a non-null current bundle id.",
        );
      }

      return {
        ...commonParams,
        fromBundleId: null,
        toBundleId: bundleId,
        type: "UNCHANGED",
        updateStrategy: null,
      };
    }
    case "UPDATE_APPLIED":
    case "RECOVERED":
      if (!analyticsEvent) {
        throw new Error(
          "[HotUpdater] Native launch report is missing persisted metadata required for automatic analytics.",
        );
      }

      switch (analyticsEvent.type) {
        case "UPDATE_APPLIED":
          return {
            ...commonParams,
            fromBundleId: analyticsEvent.fromBundleId,
            toBundleId: analyticsEvent.toBundleId,
            type: "UPDATE_APPLIED",
            updateStrategy: analyticsEvent.updateStrategy,
          };
        case "RECOVERED":
          return {
            ...commonParams,
            fromBundleId: analyticsEvent.fromBundleId,
            toBundleId: analyticsEvent.toBundleId,
            type: "RECOVERED",
            updateStrategy: analyticsEvent.updateStrategy,
          };
        default:
          return assertNever(analyticsEvent.type);
      }
    default:
      return assertNever(nativeResult);
  }
};

const maybeSendAutomaticAnalytics = async (
  options: NotifyAppReadyOptions,
  nativeResult: NotifyAppReadyResult,
  analyticsEvent: NotifyAppReadyAnalyticsEvent | null,
): Promise<void> => {
  if (!options.analytics || didAttemptAutomaticAnalytics) {
    return;
  }

  didAttemptAutomaticAnalytics = true;

  if (!options.resolver?.notifyAppReady) {
    throw new Error(
      "[HotUpdater] Automatic analytics requires resolver.notifyAppReady().",
    );
  }

  if (nativeResult.status !== "UNCHANGED" && !analyticsEvent) {
    throw new Error(
      "[HotUpdater] Native launch report is missing persisted metadata required for automatic analytics.",
    );
  }

  await options.resolver.notifyAppReady(
    buildNotifyAppReadyAnalyticsParams(nativeResult, analyticsEvent, options),
  );
};

export const handleNotifyAppReady = async (
  options: NotifyAppReadyOptions,
): Promise<void> => {
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
      const warning = error instanceof Error ? error : new Error(String(error));
      console.warn(
        "[HotUpdater] Automatic notifyAppReady analytics failed:",
        warning,
      );
    }

    options.onNotifyAppReady?.(nativeResult);
  } catch (error) {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    options.onError?.(error);
    console.warn("[HotUpdater] Failed to notify app ready:", normalizedError);
  }
};
