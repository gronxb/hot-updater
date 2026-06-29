import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";
import type {
  HotUpdaterBaseURL,
  HotUpdaterResolver,
  ResolverNotifyAppReadyParams,
} from "./types";

export interface HotUpdaterLifecycleNotifierOptions {
  baseURL: HotUpdaterBaseURL;
  telemetryKey: string;
}

export type HotUpdaterCloudLifecycleNotifierOptions =
  HotUpdaterLifecycleNotifierOptions;

type HotUpdaterCloudLifecycleStatus = "ACTIVE" | "RECOVERED";

const TELEMETRY_KEY_PREFIX = "hutk_";
const NOTIFY_APP_READY_PATH = "/api/notify-app-ready";

const resolveBaseURL = async (baseURL: HotUpdaterBaseURL): Promise<string> => {
  const resolvedBaseURL =
    typeof baseURL === "function" ? await baseURL() : baseURL;

  if (!resolvedBaseURL) {
    throw new Error("baseURL resolver must return a non-empty string");
  }

  return resolvedBaseURL.replace(/\/+$/, "");
};

const validateTelemetryKey = (telemetryKey: string): void => {
  if (!telemetryKey.startsWith(TELEMETRY_KEY_PREFIX)) {
    throw new Error("HotUpdater Cloud telemetryKey must start with hutk_");
  }

  if (telemetryKey.length === TELEMETRY_KEY_PREFIX.length) {
    throw new Error(
      "HotUpdater Cloud telemetryKey must start with hutk_ and include a key suffix",
    );
  }
};

const cloudLifecycleStatusFor = (
  params: ResolverNotifyAppReadyParams,
): HotUpdaterCloudLifecycleStatus => {
  if (params.status === "RECOVERED") return "RECOVERED";
  return "ACTIVE";
};

const createRequestBody = (params: ResolverNotifyAppReadyParams) => ({
  bundleId: params.bundleId,
  channel: params.channel,
  crashedBundleId: params.crashedBundleId,
  eventId: params.eventId,
  installId: params.installId,
  observedAt: new Date().toISOString(),
  platform: params.platform,
  status: cloudLifecycleStatusFor(params),
});

export const createHotUpdaterLifecycleNotifier = (
  options: HotUpdaterLifecycleNotifierOptions,
): NonNullable<HotUpdaterResolver["notifyAppReady"]> => {
  validateTelemetryKey(options.telemetryKey);

  return async (params) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, params.requestTimeout ?? 5000);

    try {
      const baseURL = await resolveBaseURL(options.baseURL);
      const response = await fetch(`${baseURL}${NOTIFY_APP_READY_PATH}`, {
        body: JSON.stringify(createRequestBody(params)),
        headers: {
          "Content-Type": "application/json",
          "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
          "x-hot-updater-telemetry-key": options.telemetryKey,
        },
        method: "POST",
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(response.statusText || `HTTP ${response.status}`);
      }

      return {
        crashedBundleId: params.crashedBundleId,
        status: params.status,
      };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };
};

export const createHotUpdaterCloudLifecycleNotifier =
  createHotUpdaterLifecycleNotifier;
