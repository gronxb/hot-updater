import type { AppUpdateInfo } from "@hot-updater/core";

import { fetchUpdateInfo } from "./fetchUpdateInfo";
import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";
import type {
  HotUpdaterBaseURL,
  HotUpdaterResolver,
  ResolverCheckUpdateParams,
  ResolverNotifyAppReadyParams,
} from "./types";

const resolveBaseURL = async (baseURL: HotUpdaterBaseURL): Promise<string> => {
  const resolvedBaseURL =
    typeof baseURL === "function" ? await baseURL() : baseURL;

  if (!resolvedBaseURL) {
    throw new Error("baseURL resolver must return a non-empty string");
  }

  return resolvedBaseURL;
};

/**
 * Creates a default resolver that uses baseURL for network operations.
 * This encapsulates the existing baseURL logic into a resolver.
 *
 * @param baseURL - The base URL for the update server, or a function that
 * resolves it before each update check.
 * @returns A HotUpdaterResolver that uses the baseURL
 */
export function createDefaultResolver(
  baseURL: HotUpdaterBaseURL,
): HotUpdaterResolver {
  return {
    checkUpdate: async (
      params: ResolverCheckUpdateParams,
    ): Promise<AppUpdateInfo | null> => {
      const resolvedBaseURL = (await resolveBaseURL(baseURL)).replace(
        /\/+$/,
        "",
      );
      let url: string;
      const cohortPath = `/${encodeURIComponent(params.cohort)}`;

      if (params.updateStrategy === "fingerprint") {
        if (!params.fingerprintHash) {
          throw new Error("Fingerprint hash is required");
        }
        url = `${resolvedBaseURL}/fingerprint/${params.platform}/${params.fingerprintHash}/${params.channel}/${params.minBundleId}/${params.bundleId}${cohortPath}`;
      } else {
        url = `${resolvedBaseURL}/app-version/${params.platform}/${params.appVersion}/${params.channel}/${params.minBundleId}/${params.bundleId}${cohortPath}`;
      }

      return fetchUpdateInfo({
        url,
        requestHeaders: {
          ...params.requestHeaders,
          "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
        },
        requestTimeout: params.requestTimeout,
      });
    },
    notifyAppReady: async (
      params: ResolverNotifyAppReadyParams,
    ): Promise<void> => {
      const resolvedBaseURL = (await resolveBaseURL(baseURL)).replace(
        /\/+$/,
        "",
      );
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, params.requestTimeout ?? 5000);

      try {
        const response = await fetch(`${resolvedBaseURL}/events`, {
          body: JSON.stringify({
            appVersion: params.appVersion,
            channel: params.channel,
            cohort: params.cohort,
            fingerprintHash: params.fingerprintHash,
            fromBundleId: params.fromBundleId,
            installId: params.installId,
            platform: params.platform,
            toBundleId: params.toBundleId,
            type: params.type,
            updateStrategy: params.updateStrategy,
            ...(params.userId != null ? { userId: params.userId } : {}),
            ...(params.username != null ? { username: params.username } : {}),
          }),
          headers: {
            "Content-Type": "application/json",
            ...params.requestHeaders,
            "Hot-Updater-SDK-Version": HOT_UPDATER_SDK_VERSION,
          },
          method: "POST",
          signal: controller.signal,
        });

        if (response.status !== 204) {
          throw new Error(
            `Expected HTTP 204 from /events, received ${response.status}`,
          );
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Request timed out");
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}
