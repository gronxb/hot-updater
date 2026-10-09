import {
  ARTIFACT_PROTOCOL_VERSION,
  canonicalizeAppVersion,
  encodeChannelKey,
  resolveBaseURL,
  type ArtifactInfo,
  type HotUpdaterBaseURL,
  type ReleaseCatalog,
  type UpdateHttpResponse,
} from "@hot-updater/protocol";

import { fetchJSON, FetchJSONResponseError } from "./fetchJSON";
import { fetchReleaseCatalogWithCache } from "./releaseCatalogCache";
import { InvalidUpdateResponseError } from "./updateError";

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

export interface HotUpdaterHttpSession {
  /** Resolves to null when the server says the scope has no catalog, so no update. */
  fetchReleaseCatalog: (
    params: ReleaseCatalogRequest,
  ) => Promise<ReleaseCatalog | null>;
  resolveArtifact: (params: ArtifactRequest) => Promise<ArtifactInfo>;
}

export interface HotUpdaterHttpClient {
  createSession: () => Promise<HotUpdaterHttpSession>;
}

const resolveArtifactUrl = (baseURL: string, value: string): string => {
  if (/^https?:\/\//i.test(value)) {
    try {
      new URL(value);
    } catch (error) {
      throw new InvalidUpdateResponseError(`Invalid artifact URL: ${value}`, {
        cause: error,
      });
    }
    return value;
  }
  if (!value.startsWith("/storage/")) {
    throw new InvalidUpdateResponseError(
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
  manifestUrl: resolveArtifactUrl(baseURL, info.manifestUrl),
  ...(info.archiveUrl
    ? { archiveUrl: resolveArtifactUrl(baseURL, info.archiveUrl) }
    : {}),
  assets: Object.fromEntries(
    Object.entries(info.assets).map(([path, asset]) => [
      path,
      {
        ...asset,
        file: {
          ...asset.file,
          url: resolveArtifactUrl(baseURL, asset.file.url),
        },
        ...(asset.patch
          ? {
              patch: {
                ...asset.patch,
                patchUrl: resolveArtifactUrl(baseURL, asset.patch.patchUrl),
              },
            }
          : {}),
      },
    ]),
  ),
});

const requireArtifactProtocolV1 = (info: ArtifactInfo): ArtifactInfo => {
  if (
    info.artifactProtocolVersion !== ARTIFACT_PROTOCOL_VERSION ||
    !info.assets ||
    !info.manifestUrl ||
    !info.manifestFileHash ||
    (info.archiveUrl !== undefined && typeof info.archiveUrl !== "string")
  ) {
    throw new InvalidUpdateResponseError(
      `Server does not support artifact protocol ${ARTIFACT_PROTOCOL_VERSION}.`,
    );
  }
  for (const asset of Object.values(info.assets)) {
    if (!asset.file?.url || !asset.fileHash) {
      throw new InvalidUpdateResponseError(
        "Artifact protocol 1 requires an original file for every asset.",
      );
    }
  }
  return info;
};

const createSession = (
  baseURL: string,
  onResponse?: (response: UpdateHttpResponse) => void,
): HotUpdaterHttpSession => ({
  fetchReleaseCatalog: async (params): Promise<ReleaseCatalog | null> => {
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
      ...(onResponse ? { onResponse } : {}),
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
    let info: ArtifactInfo;
    try {
      info = await fetchJSON<ArtifactInfo>({
        ...(onResponse ? { onResponse } : {}),
        requestHeaders: params.requestHeaders,
        requestTimeout: params.requestTimeout,
        url: `${baseURL}/artifacts/v1/${encodeURIComponent(
          params.targetBundleId,
        )}/from/${encodeURIComponent(params.currentBundleId)}`,
      });
    } catch (error) {
      if (error instanceof FetchJSONResponseError && error.status === 404) {
        throw new InvalidUpdateResponseError(
          `Server does not support artifact protocol ${ARTIFACT_PROTOCOL_VERSION}.`,
          { cause: error },
        );
      }
      throw error;
    }
    return resolveArtifactUrls(baseURL, requireArtifactProtocolV1(info));
  },
});

/** Creates the private HTTP client HotUpdater.init configures. */
export const createHttpClient = (
  baseURL: HotUpdaterBaseURL,
  onResponse?: (response: UpdateHttpResponse) => void,
): HotUpdaterHttpClient => ({
  createSession: async () =>
    createSession(await resolveBaseURL(baseURL), onResponse),
});
