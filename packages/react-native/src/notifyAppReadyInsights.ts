import { Platform } from "react-native";

import type { HotUpdaterError } from "./error";
import type { InsightsEventParams, HotUpdaterHttpClient } from "./httpClient";
import {
  getAppVersion,
  getBundleId,
  getChannel,
  getCohort,
  getFingerprintHash,
  getInstallId,
  getPersistedUserIdentity,
  type NotifyAppReadyInsightsEvent,
  type NotifyAppReadyResult,
  readNotifyAppReady,
} from "./native";

export type NotifyAppReadyOptions = {
  insights?: boolean;
  client: HotUpdaterHttpClient;
  requestHeaders?: Record<string, string>;
  requestTimeout?: number;
  reportUnchanged?: boolean;
  onNotifyAppReady?: (result: NotifyAppReadyResult) => void;
  onError?: (error: HotUpdaterError | Error | unknown) => void;
};

type RequestAnimationFrame = (callback: (timestamp: number) => void) => number;

let didAttemptAutomaticInsights = false;
let didDownload = false;
let readinessPromise: Promise<NotifyAppReadyResult | undefined> | undefined;

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

const buildNotifyAppReadyInsightsParams = (
  nativeResult: NotifyAppReadyResult,
  insightsEvent: NotifyAppReadyInsightsEvent | null,
  options: Pick<NotifyAppReadyOptions, "requestHeaders" | "requestTimeout">,
): InsightsEventParams => {
  const appVersion = getAppVersion();

  if (!appVersion) {
    throw new Error(
      "[HotUpdater] Automatic insights requires a non-null native app version.",
    );
  }

  const { userId, username } = getPersistedUserIdentity();
  const installId = getInstallId();

  if (!installId) {
    throw new Error(
      "[HotUpdater] Automatic insights requires a non-null native install id.",
    );
  }

  const platform: "ios" | "android" =
    Platform.OS === "android" ? "android" : "ios";

  const commonParams = {
    appVersion,
    channel: getChannel(),
    cohort: getCohort(),
    fingerprintHash: getFingerprintHash(),
    fromReleaseId: insightsEvent?.fromReleaseId ?? null,
    installId,
    platform,
    requestHeaders: options.requestHeaders,
    requestTimeout: options.requestTimeout,
    toReleaseId: insightsEvent?.toReleaseId ?? null,
    ...(userId != null ? { userId } : {}),
    ...(username != null ? { username } : {}),
  };

  switch (nativeResult.status) {
    case "UNCHANGED": {
      const bundleId = getBundleId();

      if (!bundleId) {
        throw new Error(
          "[HotUpdater] Automatic insights requires a non-null current bundle id.",
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
      if (!insightsEvent) {
        throw new Error(
          "[HotUpdater] Native launch report is missing persisted metadata required for automatic insights.",
        );
      }

      switch (insightsEvent.type) {
        case "UPDATE_APPLIED":
          return {
            ...commonParams,
            fromBundleId: insightsEvent.fromBundleId,
            toBundleId: insightsEvent.toBundleId,
            type: "UPDATE_APPLIED",
            updateStrategy: insightsEvent.updateStrategy,
          };
        case "RECOVERED":
          return {
            ...commonParams,
            fromBundleId: insightsEvent.fromBundleId,
            toBundleId: insightsEvent.toBundleId,
            type: "RECOVERED",
            updateStrategy: insightsEvent.updateStrategy,
          };
        default:
          return assertNever(insightsEvent.type);
      }
    default:
      return assertNever(nativeResult);
  }
};

let lastInsightsReport = Promise.resolve();
const sendInsights = (
  options: Pick<NotifyAppReadyOptions, "client">,
  params: InsightsEventParams,
): Promise<void> => {
  lastInsightsReport = lastInsightsReport
    .catch(() => {})
    .then(async () => {
      const session = await options.client.createSession();
      await session.sendInsightsEvent(params);
    });
  return lastInsightsReport;
};

const maybeSendAutomaticInsights = async (
  options: NotifyAppReadyOptions,
  nativeResult: NotifyAppReadyResult,
  insightsEvent: NotifyAppReadyInsightsEvent | null,
): Promise<void> => {
  if (
    !options.insights ||
    didAttemptAutomaticInsights ||
    (nativeResult.status === "UNCHANGED" &&
      (options.reportUnchanged === false || didDownload))
  ) {
    return;
  }

  didAttemptAutomaticInsights = true;

  if (nativeResult.status !== "UNCHANGED" && !insightsEvent) {
    throw new Error(
      "[HotUpdater] Native launch report is missing persisted metadata required for automatic insights.",
    );
  }

  await sendInsights(
    options,
    buildNotifyAppReadyInsightsParams(nativeResult, insightsEvent, options),
  );
};

const notifyAppReady = async (
  options: NotifyAppReadyOptions,
): Promise<NotifyAppReadyResult | undefined> => {
  try {
    let nativeReadResult: ReturnType<typeof readNotifyAppReady>;
    do {
      await waitForNextFrame();
      nativeReadResult = readNotifyAppReady();
    } while (nativeReadResult.pending);

    const { insightsEvent, result: nativeResult } = nativeReadResult;

    try {
      await maybeSendAutomaticInsights(options, nativeResult, insightsEvent);
    } catch (error) {
      const warning = error instanceof Error ? error : new Error(String(error));
      console.warn(
        "[HotUpdater] Automatic notifyAppReady insights failed:",
        warning,
      );
    }

    options.onNotifyAppReady?.(nativeResult);
    return nativeResult;
  } catch (error) {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    options.onError?.(error);
    console.warn("[HotUpdater] Failed to notify app ready:", normalizedError);
    return undefined;
  }
};

export const handleNotifyAppReady = (
  options: NotifyAppReadyOptions,
): Promise<NotifyAppReadyResult | undefined> => {
  readinessPromise = notifyAppReady(options);
  return readinessPromise;
};

/** Called after an automatic update check finds no download or transition. */
export const reportNoChange = async (
  options: NotifyAppReadyOptions,
): Promise<void> => {
  try {
    await maybeSendAutomaticInsights(options, { status: "UNCHANGED" }, null);
  } catch (error) {
    console.warn("[HotUpdater] Automatic no-change insights failed:", error);
  }
};

let lastDownloadedSelection: string | undefined;

/** Report only after the archive/diff has been verified and staged successfully. */
export const reportBundleDownloaded = async (
  options: Pick<
    NotifyAppReadyOptions,
    "insights" | "client" | "requestHeaders" | "requestTimeout"
  >,
  transition: {
    readonly fromBundleId: string;
    readonly fromReleaseId: string | null;
    readonly toBundleId: string;
    readonly toReleaseId: string | null;
    readonly channel: string;
    readonly updateStrategy: "fingerprint" | "appVersion";
  },
): Promise<void> => {
  if (!options.insights || transition.fromBundleId === transition.toBundleId)
    return;
  const key = JSON.stringify([
    transition.channel,
    transition.toReleaseId,
    transition.toBundleId,
  ]);
  if (lastDownloadedSelection === key) return;
  lastDownloadedSelection = key;
  // A later init/mount in this JS runtime must not overwrite pending apply with UNCHANGED.
  didDownload = true;
  try {
    await readinessPromise;
    const common = buildNotifyAppReadyInsightsParams(
      { status: "UNCHANGED" },
      null,
      options,
    );
    await sendInsights(options, {
      ...common,
      ...transition,
      type: "UPDATE_DOWNLOADED",
    });
  } catch (error) {
    console.warn("[HotUpdater] Download insights failed:", error);
  }
};
