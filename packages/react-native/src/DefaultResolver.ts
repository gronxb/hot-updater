import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  type AppUpdateAvailableInfo,
  type ReleaseCatalog,
} from "@hot-updater/core";
import { canonicalizeAppVersion } from "@hot-updater/plugin-core";

import { fetchJSON } from "./fetchUpdateInfo";
import { fetchReleaseCatalogWithCache } from "./releaseCatalogCache";
import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";
import type {
  HotUpdaterBaseURL,
  HotUpdaterResolver,
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
  options: { readonly authorityId?: string } = {},
): HotUpdaterResolver {
  const authorityId = options.authorityId ?? "default";
  return {
    authorityId,
    catalogCachePartition: "x-api-key",
    fetchReleaseCatalog: async (params): Promise<ReleaseCatalog> => {
      const resolvedBaseURL = (await resolveBaseURL(baseURL)).replace(
        /\/+$/,
        "",
      );
      const channelKey = encodeChannelKey(params.channel);
      let strategyValue: string;
      if (params.updateStrategy === "fingerprint") {
        if (!params.fingerprintHash) {
          throw new Error("Fingerprint hash is required");
        }
        strategyValue = params.fingerprintHash;
      } else {
        const appVersion = canonicalizeAppVersion(params.appVersion);
        if (appVersion === null) throw new Error("Invalid app version");
        strategyValue = appVersion;
      }
      const strategyPath =
        params.updateStrategy === "fingerprint" ? "fingerprint" : "app-version";
      const url = `${resolvedBaseURL}/v2/release-catalogs/${strategyPath}/${encodeURIComponent(
        authorityId,
      )}/${params.platform}/${channelKey}/${encodeURIComponent(strategyValue)}`;
      const scopeKey = createReleaseCatalogScopeKey(
        params.updateStrategy === "fingerprint"
          ? {
              authorityId,
              channelKey,
              fingerprintHash: strategyValue,
              platform: params.platform,
              strategy: "FINGERPRINT",
            }
          : {
              authorityId,
              channelKey,
              platform: params.platform,
              strategy: "APP_VERSION",
            },
      );
      return fetchReleaseCatalogWithCache({
        authorityId,
        baseURL: resolvedBaseURL,
        requestHeaders: params.requestHeaders,
        requestTimeout: params.requestTimeout,
        scopeKey,
        url,
      });
    },
    resolveArtifact: async (params): Promise<AppUpdateAvailableInfo> => {
      const resolvedBaseURL = (await resolveBaseURL(baseURL)).replace(
        /\/+$/,
        "",
      );
      return fetchJSON<AppUpdateAvailableInfo>({
        requestHeaders: params.requestHeaders,
        requestTimeout: params.requestTimeout,
        url: `${resolvedBaseURL}/v2/artifacts/${encodeURIComponent(
          params.targetBundleId,
        )}/from/${encodeURIComponent(params.currentBundleId)}`,
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
            ...(params.fromReleaseId === undefined
              ? {}
              : { fromReleaseId: params.fromReleaseId }),
            installId: params.installId,
            platform: params.platform,
            sdkVersion: HOT_UPDATER_SDK_VERSION,
            toBundleId: params.toBundleId,
            ...(params.toReleaseId === undefined
              ? {}
              : { toReleaseId: params.toReleaseId }),
            type: params.type,
            updateStrategy: params.updateStrategy,
            ...(params.userId != null ? { userId: params.userId } : {}),
            ...(params.username != null ? { username: params.username } : {}),
          }),
          headers: {
            "Content-Type": "application/json",
            ...params.requestHeaders,
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
