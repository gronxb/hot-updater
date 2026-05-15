import type { AppUpdateInfo } from "@hot-updater/core";

import { fetchUpdateInfo } from "./fetchUpdateInfo";
import type {
  HotUpdaterBaseURL,
  HotUpdaterResolver,
  ResolverCheckUpdateParams,
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
      const resolvedBaseURL = await resolveBaseURL(baseURL);
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
        requestHeaders: params.requestHeaders,
        requestTimeout: params.requestTimeout,
      });
    },
  };
}
