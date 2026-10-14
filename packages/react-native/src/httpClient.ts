import {
  ARTIFACT_FILES_PROTOCOL_VERSION,
  ARTIFACT_PROTOCOL_VERSION,
  canonicalizeAppVersion,
  encodeChannelKey,
  resolveBaseURL,
  type ArtifactInfo,
  type ArtifactInfoV2,
  type ChangedAssetPatch,
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
  /**
   * The newest artifact protocol native installs: 1 for native built from an
   * SDK older than protocol v2. 2 by default.
   */
  readonly artifactProtocol?: 1 | 2;
  readonly targetBundleId: string;
  readonly currentBundleId: string;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
}

/**
 * How native downloads a Bundle: with a URL for every file in artifact
 * protocol v1, or in v2 with only the Hermes patch, asking `filesUrl` for the
 * files it downloads one by one.
 */
export type ResolvedArtifact =
  | {
      readonly manifestUrl: string;
      readonly manifestFileHash: string;
      readonly archiveUrl?: string;
      readonly assets: ArtifactInfo["assets"];
    }
  | {
      readonly manifestUrl: string;
      readonly manifestFileHash: string;
      readonly archiveUrl?: string;
      readonly patch?: ChangedAssetPatch & { assetPath: string };
      readonly filesUrl: string;
    };

export interface HotUpdaterHttpSession {
  /** Resolves to null when the server says the scope has no catalog, so no update. */
  fetchReleaseCatalog: (
    params: ReleaseCatalogRequest,
  ) => Promise<ReleaseCatalog | null>;
  resolveArtifact: (params: ArtifactRequest) => Promise<ResolvedArtifact>;
}

export interface HotUpdaterHttpClient {
  createSession: () => Promise<HotUpdaterHttpSession>;
}

/** A URL the device downloads from: the server returns each one absolute. */
const requireArtifactUrl = (value: string): string => {
  if (!/^https?:\/\//i.test(value)) {
    throw new InvalidUpdateResponseError(
      "Artifact URLs must be absolute HTTP(S) URLs.",
    );
  }
  try {
    new URL(value);
  } catch (error) {
    throw new InvalidUpdateResponseError(`Invalid artifact URL: ${value}`, {
      cause: error,
    });
  }
  return value;
};

// Legacy: artifact protocol v1: validates a server that predates v2; remove with the fallback.
const requireArtifactUrls = (info: ArtifactInfo): ArtifactInfo => {
  requireArtifactUrl(info.manifestUrl);
  if (info.archiveUrl) requireArtifactUrl(info.archiveUrl);
  for (const asset of Object.values(info.assets)) {
    requireArtifactUrl(asset.file.url);
    if (asset.patch) requireArtifactUrl(asset.patch.patchUrl);
  }
  return info;
};

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

const requireArtifactProtocolV2 = (info: ArtifactInfoV2): ArtifactInfoV2 => {
  if (
    info?.artifactProtocolVersion !== ARTIFACT_FILES_PROTOCOL_VERSION ||
    !info.manifestUrl ||
    !info.manifestFileHash ||
    (info.archiveUrl !== undefined && typeof info.archiveUrl !== "string") ||
    (info.patch !== undefined &&
      (!info.patch?.assetPath || !info.patch.patchUrl))
  ) {
    throw new InvalidUpdateResponseError(
      `Server does not support artifact protocol ${ARTIFACT_FILES_PROTOCOL_VERSION}.`,
    );
  }
  requireArtifactUrl(info.manifestUrl);
  if (info.archiveUrl) requireArtifactUrl(info.archiveUrl);
  if (info.patch) requireArtifactUrl(info.patch.patchUrl);
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
  resolveArtifact: async (params): Promise<ResolvedArtifact> => {
    const target = encodeURIComponent(params.targetBundleId);
    const route = `${target}/from/${encodeURIComponent(params.currentBundleId)}`;
    const request = {
      ...(onResponse ? { onResponse } : {}),
      requestHeaders: params.requestHeaders,
      requestTimeout: params.requestTimeout,
    };
    // Legacy: artifact protocol v1, for native that predates v2 and for a
    // server that predates it (404). Remove once neither is supported.
    const resolveV1 = async (): Promise<ResolvedArtifact> =>
      requireArtifactUrls(
        requireArtifactProtocolV1(
          await fetchJSON<ArtifactInfo>({
            ...request,
            url: `${baseURL}/artifacts/v1/${route}`,
          }),
        ),
      );
    if (params.artifactProtocol === 1) return resolveV1();
    let info: ArtifactInfoV2;
    try {
      info = await fetchJSON<ArtifactInfoV2>({
        ...request,
        url: `${baseURL}/artifacts/v2/${route}`,
      });
    } catch (error) {
      if (!(error instanceof FetchJSONResponseError) || error.status !== 404) {
        throw error;
      }
      return resolveV1();
    }
    const { archiveUrl, manifestFileHash, manifestUrl, patch } =
      requireArtifactProtocolV2(info);
    return {
      ...(archiveUrl ? { archiveUrl } : {}),
      ...(patch ? { patch } : {}),
      filesUrl: `${baseURL}/artifacts/v2/${target}/files`,
      manifestFileHash,
      manifestUrl,
    };
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
