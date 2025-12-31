import type { AppUpdateInfo } from "@hot-updater/core";
import { fetchUpdateInfo } from "./fetchUpdateInfo";
import type { HotUpdaterResolver, ResolverCheckUpdateParams } from "./types";

/**
 * Creates a default resolver that uses baseURL for network operations.
 * This encapsulates the existing baseURL logic into a resolver.
 *
 * @param baseURL - The base URL for the update server
 * @returns A HotUpdaterResolver that uses the baseURL
 */
export function createDefaultResolver(baseURL: string): HotUpdaterResolver {
  return {
    checkUpdate: async (
      params: ResolverCheckUpdateParams,
    ): Promise<AppUpdateInfo | null> => {
      // Build URL based on strategy (existing buildUpdateUrl logic)
      let url: string;
      if (params.updateStrategy === "fingerprint") {
        if (!params.fingerprintHash) {
          throw new Error("Fingerprint hash is required");
        }
        url = `${baseURL}/fingerprint/${params.platform}/${params.fingerprintHash}/${params.channel}/${params.minBundleId}/${params.bundleId}`;
      } else {
        url = `${baseURL}/app-version/${params.platform}/${params.appVersion}/${params.channel}/${params.minBundleId}/${params.bundleId}`;
      }

      // Use existing fetchUpdateInfo
      return fetchUpdateInfo({
        url,
        requestHeaders: params.requestHeaders,
        requestTimeout: params.requestTimeout,
      });
    },
  };
}
