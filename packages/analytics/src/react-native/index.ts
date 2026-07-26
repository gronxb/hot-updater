import { HotUpdater } from "@hot-updater/react-native";
import type { NotifyAppReadyResult } from "@hot-updater/react-native";
import {
  getInstallId,
  getPersistedUserIdentity,
  HOT_UPDATER_SDK_VERSION,
  setPersistedUserIdentity,
} from "@hot-updater/react-native/runtime-metadata";
import { Platform } from "react-native";

import type { CreateBundleEventRequest } from "../domain";
import {
  createDefaultTransport,
  type ReactNativeAnalyticsBaseURL,
  type ReactNativeAnalyticsTransport,
} from "./transport";

export type {
  ReactNativeAnalyticsBaseURL,
  ReactNativeAnalyticsTransport,
} from "./transport";

export type ReactNativeAnalyticsUserIdentity = {
  readonly userId?: string | number | null;
  readonly username?: string | null;
};

type BaseURLAnalyticsOptions = {
  readonly baseURL: ReactNativeAnalyticsBaseURL;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly requestTimeout?: number;
  readonly transport?: never;
};

type CustomTransportAnalyticsOptions = {
  readonly baseURL?: never;
  readonly requestHeaders?: never;
  readonly requestTimeout?: never;
  readonly transport: ReactNativeAnalyticsTransport;
};

export type CreateReactNativeAnalyticsOptions = (
  | BaseURLAnalyticsOptions
  | CustomTransportAnalyticsOptions
) & {
  readonly onError?: (error: unknown) => void;
};

export type ReactNativeAnalyticsClient = {
  readonly getInstallId: () => string;
  readonly recordAppReady: (result: NotifyAppReadyResult) => void;
  readonly setUser: (identity: ReactNativeAnalyticsUserIdentity | null) => void;
};

class AnalyticsRuntimeMetadataError extends Error {
  readonly name = "AnalyticsRuntimeMetadataError";
}

let didAttemptAppReadyEvent = false;

const getCommonEventFields = () => {
  const appVersion = HotUpdater.getAppVersion();
  if (appVersion === null) {
    throw new AnalyticsRuntimeMetadataError(
      "Analytics requires a native app version.",
    );
  }

  const identity = getPersistedUserIdentity();
  return {
    appVersion,
    channel: HotUpdater.getChannel(),
    cohort: HotUpdater.getCohort(),
    fingerprintHash: HotUpdater.getFingerprintHash(),
    installId: getInstallId(),
    platform:
      Platform.OS === "android" ? ("android" as const) : ("ios" as const),
    ...(identity.userId !== undefined ? { userId: identity.userId } : {}),
    ...(identity.username !== undefined ? { username: identity.username } : {}),
  };
};

const createEvent = (
  result: NotifyAppReadyResult,
): CreateBundleEventRequest | null => {
  switch (result.status) {
    case "UNCHANGED":
      return {
        ...getCommonEventFields(),
        fromBundleId: null,
        toBundleId: HotUpdater.getBundleId(),
        type: "UNCHANGED",
        updateStrategy: null,
      };
    case "UPDATE_APPLIED":
    case "RECOVERED":
      if (result.updateStrategy === undefined) {
        return null;
      }
      return {
        ...getCommonEventFields(),
        fromBundleId: result.fromBundleId,
        toBundleId: result.toBundleId,
        type: result.status,
        updateStrategy: result.updateStrategy,
      };
    default:
      return result;
  }
};

export const createReactNativeAnalytics = (
  options: CreateReactNativeAnalyticsOptions,
): ReactNativeAnalyticsClient => {
  const transport =
    options.transport ??
    createDefaultTransport({
      baseURL: options.baseURL,
      requestHeaders: options.requestHeaders,
      requestTimeout: options.requestTimeout,
      sdkVersion: HOT_UPDATER_SDK_VERSION,
    });

  return {
    getInstallId,
    recordAppReady(result) {
      if (didAttemptAppReadyEvent) {
        return;
      }
      didAttemptAppReadyEvent = true;

      void Promise.resolve()
        .then(() => createEvent(result))
        .then((event) => (event === null ? undefined : transport.send(event)))
        .catch((error: unknown) => {
          console.warn("[HotUpdater] Analytics event delivery failed.");
          options.onError?.(error);
        })
        .catch(() => {
          console.warn("[HotUpdater] Analytics onError callback failed.");
        });
    },
    setUser(identity) {
      if (identity === null) {
        setPersistedUserIdentity(null);
        return;
      }
      setPersistedUserIdentity(identity);
    },
  };
};
