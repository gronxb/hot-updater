import type { AppUpdateInfo } from "@hot-updater/core";

import { fetchUpdateInfo } from "./fetchUpdateInfo";
import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";
import type { HotUpdaterResolver, ResolverCheckUpdateParams } from "./types";

/**
 * Creates a default resolver that uses baseURL for network operations.
 * This encapsulates the existing baseURL logic into a resolver.
 *
 * @param baseURL - The base URL for the update server
 * @returns A HotUpdaterResolver that uses the baseURL
 */
export function createDefaultResolver(baseURL: string): HotUpdaterResolver {
  const normalizedBaseURL = baseURL.replace(/\/+$/, "");

  return {
    checkUpdate: async (
      params: ResolverCheckUpdateParams,
    ): Promise<AppUpdateInfo | null> => {
      let url: string;
      const cohortPath = `/${encodeURIComponent(params.cohort)}`;

      if (params.updateStrategy === "fingerprint") {
        if (!params.fingerprintHash) {
          throw new Error("Fingerprint hash is required");
        }
        url = `${normalizedBaseURL}/fingerprint/${params.platform}/${params.fingerprintHash}/${params.channel}/${params.minBundleId}/${params.bundleId}${cohortPath}`;
      } else {
        url = `${normalizedBaseURL}/app-version/${params.platform}/${params.appVersion}/${params.channel}/${params.minBundleId}/${params.bundleId}${cohortPath}`;
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
  };
}
