import {
  encodeChannelKey,
  type ArtifactInfo,
  type ReleaseCatalog,
} from "@hot-updater/core";
import { canonicalizeAppVersion } from "@hot-updater/plugin-core";

import { fetchJSON } from "./fetchJSON";
import { fetchReleaseCatalogWithCache } from "./releaseCatalogCache";
import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";
import type { HotUpdaterBaseURL } from "./types";

export interface ReleaseCatalogRequest {
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly updateStrategy: "fingerprint" | "appVersion";
  readonly appVersion: string;
  readonly fingerprintHash: string | null;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
}

export interface ArtifactRequest {
  readonly targetBundleId: string;
  readonly currentBundleId: string;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
}

interface InsightsEventCommonParams {
  readonly installId: string;
  readonly userId?: string;
  readonly username?: string;
  readonly platform: "ios" | "android";
  readonly appVersion: string;
  readonly channel: string;
  readonly cohort: string;
  readonly fingerprintHash: string | null;
  readonly fromReleaseId?: string | null;
  readonly toReleaseId?: string | null;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
}

type InsightsTransitionEventParams = InsightsEventCommonParams & {
  readonly type: "UPDATE_APPLIED" | "RECOVERED" | "RELEASE_ADOPTED";
  readonly fromBundleId: string;
  readonly toBundleId: string;
  readonly updateStrategy: "fingerprint" | "appVersion";
};

type InsightsUnchangedEventParams = InsightsEventCommonParams & {
  readonly type: "UNCHANGED";
  readonly fromBundleId: null;
  readonly toBundleId: string;
  readonly updateStrategy: null;
};

export type InsightsEventParams =
  | InsightsTransitionEventParams
  | InsightsUnchangedEventParams;

export interface HotUpdaterHttpSession {
  fetchReleaseCatalog: (
    params: ReleaseCatalogRequest,
  ) => Promise<ReleaseCatalog>;
  resolveArtifact: (params: ArtifactRequest) => Promise<ArtifactInfo>;
  sendInsightsEvent: (params: InsightsEventParams) => Promise<void>;
}

export interface HotUpdaterHttpClient {
  createSession: () => Promise<HotUpdaterHttpSession>;
}

const resolveBaseURL = async (baseURL: HotUpdaterBaseURL): Promise<string> => {
  const resolvedBaseURL =
    typeof baseURL === "function" ? await baseURL() : baseURL;

  if (!resolvedBaseURL) {
    throw new Error("baseURL function must return a non-empty string");
  }

  return resolvedBaseURL.replace(/\/+$/, "");
};

const resolveArtifactUrl = (baseURL: string, value: string): string => {
  if (/^https?:\/\//i.test(value)) {
    new URL(value);
    return value;
  }
  if (!value.startsWith("/storage/")) {
    throw new Error(
      "Artifact URLs must be absolute HTTP(S) URLs or client-relative storage paths.",
    );
  }
  return `${baseURL}/${value.slice(1)}`;
};

const resolveArtifactUrls = (
  baseURL: string,
  info: ArtifactInfo,
): ArtifactInfo => ({
  ...info,
  fileUrl:
    info.fileUrl === null ? null : resolveArtifactUrl(baseURL, info.fileUrl),
  ...(info.manifestUrl === undefined
    ? {}
    : {
        manifestUrl:
          info.manifestUrl === null
            ? null
            : resolveArtifactUrl(baseURL, info.manifestUrl),
      }),
  ...(info.changedAssets === undefined
    ? {}
    : {
        changedAssets:
          info.changedAssets === null
            ? null
            : Object.fromEntries(
                Object.entries(info.changedAssets).map(([path, asset]) => [
                  path,
                  {
                    ...asset,
                    ...(asset.file
                      ? {
                          file: {
                            ...asset.file,
                            url: resolveArtifactUrl(baseURL, asset.file.url),
                          },
                        }
                      : {}),
                    ...(asset.patch
                      ? {
                          patch: {
                            ...asset.patch,
                            patchUrl: resolveArtifactUrl(
                              baseURL,
                              asset.patch.patchUrl,
                            ),
                          },
                        }
                      : {}),
                  },
                ]),
              ),
      }),
});

const sendInsightsEvent = async (
  baseURL: string,
  params: InsightsEventParams,
): Promise<void> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, params.requestTimeout ?? 5000);

  try {
    const response = await fetch(`${baseURL}/events`, {
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
};

const createSession = (baseURL: string): HotUpdaterHttpSession => ({
  fetchReleaseCatalog: async (params): Promise<ReleaseCatalog> => {
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
    const url = `${baseURL}/release-catalogs/${strategyPath}/${params.platform}/${channelKey}/${encodeURIComponent(strategyValue)}`;

    return fetchReleaseCatalogWithCache({
      baseURL,
      expectedScope:
        params.updateStrategy === "fingerprint"
          ? {
              channelKey,
              fingerprintHash: strategyValue,
              platform: params.platform,
              strategy: "FINGERPRINT",
            }
          : {
              channelKey,
              platform: params.platform,
              strategy: "APP_VERSION",
            },
      requestHeaders: params.requestHeaders,
      requestTimeout: params.requestTimeout,
      url,
    });
  },
  resolveArtifact: async (params): Promise<ArtifactInfo> => {
    const info = await fetchJSON<ArtifactInfo>({
      requestHeaders: params.requestHeaders,
      requestTimeout: params.requestTimeout,
      url: `${baseURL}/artifacts/${encodeURIComponent(
        params.targetBundleId,
      )}/from/${encodeURIComponent(params.currentBundleId)}`,
    });
    return resolveArtifactUrls(baseURL, info);
  },
  sendInsightsEvent: (params) => sendInsightsEvent(baseURL, params),
});

/** Creates the private HTTP client used by HotUpdater.init and HotUpdater.wrap. */
export const createHttpClient = (
  baseURL: HotUpdaterBaseURL,
): HotUpdaterHttpClient => ({
  createSession: async () => createSession(await resolveBaseURL(baseURL)),
});
