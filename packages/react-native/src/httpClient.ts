import {
  ARTIFACT_PROTOCOL_VERSION,
  encodeChannelKey,
  type ArtifactInfo,
  type ReleaseCatalog,
} from "@hot-updater/core";
import { canonicalizeAppVersion } from "@hot-updater/plugin-core";

import { fetchJSON, FetchJSONResponseError } from "./fetchJSON";
import { fetchReleaseCatalogWithCache } from "./releaseCatalogCache";
import { HOT_UPDATER_SDK_VERSION } from "./sdkVersion";
import type { HotUpdaterBaseURL } from "./types";
import { createUUIDv7 } from "./uuidv7";

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
  readonly type: "UPDATE_DOWNLOADED" | "UPDATE_APPLIED" | "RECOVERED";
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
  /**
   * Posts an Insights event under a client `eventId`, retrying a network
   * error, timeout, 429 or 5xx for up to three attempts in all. Resolves once
   * the event is delivered or left to background retries; rejects when its
   * first attempt fails for good, such as with a 400.
   */
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
    throw new Error(
      `Server does not support artifact protocol ${ARTIFACT_PROTOCOL_VERSION}.`,
    );
  }
  for (const asset of Object.values(info.assets)) {
    if (!asset.file?.url || !asset.fileHash) {
      throw new Error(
        "Artifact protocol 1 requires an original file for every asset.",
      );
    }
  }
  return info;
};

/** Attempts per Insights event, the first one included. */
const INSIGHTS_MAX_ATTEMPTS = 3;
/** Wait before the second attempt; it doubles for each later attempt. */
const INSIGHTS_RETRY_BASE_DELAY_MS = 1000;
/** Longest wait between attempts, a server's `Retry-After` included. */
const INSIGHTS_RETRY_MAX_DELAY_MS = 30000;

type InsightsAttemptFailure = {
  readonly error: Error;
  /** A network error, timeout, 429 or 5xx may pass on a later attempt. */
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
};

/**
 * Reads `Retry-After` as delay-seconds, the form a server under load sends;
 * an HTTP-date falls back to the backoff.
 */
const parseRetryAfterMs = (value: string | null): number | null => {
  const seconds = value?.trim();
  return seconds && /^\d+$/.test(seconds) ? Number(seconds) * 1000 : null;
};

const getRetryDelayMs = (
  failedAttempt: number,
  retryAfterMs: number | null,
): number =>
  Math.min(
    retryAfterMs ??
      // Jitter spreads the retries of installations that failed together.
      INSIGHTS_RETRY_BASE_DELAY_MS *
        2 ** (failedAttempt - 1) *
        (0.5 + Math.random()),
    INSIGHTS_RETRY_MAX_DELAY_MS,
  );

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Makes one POST, with its own timeout, and settles with its failure. */
const postInsightsEvent = async (
  baseURL: string,
  params: InsightsEventParams,
  eventId: string,
): Promise<InsightsAttemptFailure | null> => {
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
        eventId,
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

    if (response.status === 204) return null;
    return {
      error: new Error(
        `Expected HTTP 204 from /events, received ${response.status}`,
      ),
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
    };
  } catch (error: unknown) {
    // fetch rejects only when no response arrived (a timeout or a network
    // error), so a later attempt may still get through.
    return {
      error:
        error instanceof Error && error.name === "AbortError"
          ? new Error("Request timed out")
          : error instanceof Error
            ? error
            : new Error(String(error)),
      retryable: true,
      retryAfterMs: null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

type InsightsEventSender = (
  baseURL: string,
  params: InsightsEventParams,
) => Promise<void>;

/**
 * Sends Insights events one at a time and retries each in the background.
 *
 * The server keeps an installation's latest report by arrival, so a later
 * event waits behind an earlier one's retries; otherwise a retried
 * UPDATE_APPLIED could land after the UPDATE_DOWNLOADED that followed it.
 * Callers still wait only for first attempts, as they did before retries, so
 * startup, readiness and `updateBundle()` never wait out a backoff: once an
 * event backs off, every waiting caller is released, and a failure after that
 * only warns.
 */
const createInsightsEventSender = (): InsightsEventSender => {
  let queue = Promise.resolve();
  let retrying = false;
  const waiting = new Set<() => void>();

  return (baseURL, params) => {
    // One ID for every attempt, so the server counts a retried POST once.
    const eventId = createUUIDv7();

    return new Promise<void>((resolve, reject) => {
      let released = false;
      const release = () => {
        released = true;
        waiting.delete(release);
        resolve();
      };
      if (retrying) release();
      else waiting.add(release);

      queue = queue.then(async () => {
        try {
          for (let attempt = 1; ; attempt += 1) {
            const failure = await postInsightsEvent(baseURL, params, eventId);
            if (failure === null) {
              release();
              break;
            }
            if (!failure.retryable || attempt === INSIGHTS_MAX_ATTEMPTS) {
              waiting.delete(release);
              if (released) {
                console.warn(
                  `[HotUpdater] Insights ${params.type} event was not delivered:`,
                  failure.error,
                );
              } else {
                reject(failure.error);
              }
              break;
            }
            retrying = true;
            for (const releaseWaiting of waiting) releaseWaiting();
            await wait(getRetryDelayMs(attempt, failure.retryAfterMs));
          }
        } catch (error: unknown) {
          // A failed request settles in postInsightsEvent, so only a bug gets
          // here. A rejected queue would leave every later event, and a caller
          // such as `updateBundle()` waiting on one, pending forever.
          waiting.delete(release);
          if (!released) reject(error);
        } finally {
          retrying = false;
        }
      });
    });
  };
};

const createSession = (
  baseURL: string,
  sendInsightsEvent: InsightsEventSender,
): HotUpdaterHttpSession => ({
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
    let info: ArtifactInfo;
    try {
      info = await fetchJSON<ArtifactInfo>({
        requestHeaders: params.requestHeaders,
        requestTimeout: params.requestTimeout,
        url: `${baseURL}/artifacts/v1/${encodeURIComponent(
          params.targetBundleId,
        )}/from/${encodeURIComponent(params.currentBundleId)}`,
      });
    } catch (error) {
      if (error instanceof FetchJSONResponseError && error.status === 404) {
        throw new Error(
          `Server does not support artifact protocol ${ARTIFACT_PROTOCOL_VERSION}.`,
          { cause: error },
        );
      }
      throw error;
    }
    return resolveArtifactUrls(baseURL, requireArtifactProtocolV1(info));
  },
  sendInsightsEvent: (params) => sendInsightsEvent(baseURL, params),
});

/** Creates the private HTTP client used by HotUpdater.init and HotUpdater.wrap. */
export const createHttpClient = (
  baseURL: HotUpdaterBaseURL,
): HotUpdaterHttpClient => {
  // Shared by every session, since each report opens its own session.
  const sendInsightsEvent = createInsightsEventSender();
  return {
    createSession: async () =>
      createSession(await resolveBaseURL(baseURL), sendInsightsEvent),
  };
};
