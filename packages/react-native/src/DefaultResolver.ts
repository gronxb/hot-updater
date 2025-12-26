import type { AppUpdateInfo } from "@hot-updater/core";
import { fetchUpdateInfo } from "./fetchUpdateInfo";
import type {
  HotUpdaterResolver,
  ResolverCheckUpdateParams,
  ResolverTrackDeviceEventParams,
} from "./types";

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
      const deviceIdPath = params.deviceId
        ? `/${encodeURIComponent(params.deviceId)}`
        : "";
      if (params.updateStrategy === "fingerprint") {
        if (!params.fingerprintHash) {
          throw new Error("Fingerprint hash is required");
        }
        url = `${baseURL}/fingerprint/${params.platform}/${params.fingerprintHash}/${params.channel}/${params.minBundleId}/${params.bundleId}${deviceIdPath}`;
      } else {
        url = `${baseURL}/app-version/${params.platform}/${params.appVersion}/${params.channel}/${params.minBundleId}/${params.bundleId}${deviceIdPath}`;
      }

      // Use existing fetchUpdateInfo
      return fetchUpdateInfo({
        url,
        requestHeaders: params.requestHeaders,
        requestTimeout: params.requestTimeout,
      });
    },

    trackDeviceEvent: async (
      params: ResolverTrackDeviceEventParams,
    ): Promise<void> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, params.requestTimeout ?? 5000);

      const response = await fetch(`${baseURL}/api/track`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...params.requestHeaders,
        },
        body: JSON.stringify({
          deviceId: params.deviceId,
          bundleId: params.bundleId,
          eventType: params.eventType,
          platform: params.platform,
          appVersion: params.appVersion,
          channel: params.channel,
          metadata: params.metadata,
        }),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Failed to track event: ${response.status}`);
      }
    },
  };
}
