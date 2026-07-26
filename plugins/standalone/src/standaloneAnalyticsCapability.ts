import {
  createStandaloneHttp,
  StandaloneDatabaseError,
} from "./standaloneHttp";
import type { StandaloneRepositoryConfig } from "./standaloneRoutes";

type LegacyRemoteAnalyticsCapability =
  | { readonly analytics: false }
  | { readonly analytics: true; readonly mode: "dedicated" }
  | {
      readonly analytics: true;
      readonly mode: "bounded";
      readonly maxMatchingRows: number;
    };

type RemoteAnalyticsCapability = LegacyRemoteAnalyticsCapability & {
  readonly eventIngestion: boolean;
  readonly analyticsQueries: boolean;
};

type ParsedAnalyticsCapability =
  | LegacyRemoteAnalyticsCapability
  | RemoteAnalyticsCapability;

const ANALYTICS_CAPABILITY_FRESHNESS_MS = 30_000;
const ANALYTICS_CAPABILITY_MAX_STALENESS_MS = 5 * 60_000;
const ANALYTICS_CAPABILITY_TIMEOUT_MS = 5_000;

const unavailableAnalyticsCapability = {
  analytics: false,
  eventIngestion: false,
  analyticsQueries: false,
} as const satisfies RemoteAnalyticsCapability;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAnalyticsCapability = (
  value: unknown,
): value is ParsedAnalyticsCapability => {
  if (!isRecord(value) || typeof value.analytics !== "boolean") return false;
  const validStructuralCapability =
    !value.analytics ||
    value.mode === "dedicated" ||
    (value.mode === "bounded" &&
      typeof value.maxMatchingRows === "number" &&
      Number.isFinite(value.maxMatchingRows) &&
      value.maxMatchingRows > 0);
  if (!validStructuralCapability) return false;

  const legacyShape =
    value.eventIngestion === undefined && value.analyticsQueries === undefined;
  return (
    legacyShape ||
    (typeof value.eventIngestion === "boolean" &&
      typeof value.analyticsQueries === "boolean")
  );
};

const isRouteAwareAnalyticsCapability = (
  value: ParsedAnalyticsCapability,
): value is RemoteAnalyticsCapability =>
  "eventIngestion" in value &&
  typeof value.eventIngestion === "boolean" &&
  "analyticsQueries" in value &&
  typeof value.analyticsQueries === "boolean";

const isVersionResponse = (
  value: unknown,
): value is {
  readonly version: string;
  readonly capabilities?: ParsedAnalyticsCapability;
} =>
  isRecord(value) &&
  typeof value.version === "string" &&
  (value.capabilities === undefined ||
    isAnalyticsCapability(value.capabilities));

export const createAnalyticsCapabilityProbe = (
  config: StandaloneRepositoryConfig,
) => {
  const http = createStandaloneHttp(config);
  let cached:
    | {
        capability: RemoteAnalyticsCapability;
        fetchedAtMs: number;
      }
    | undefined;
  let pending: Promise<RemoteAnalyticsCapability> | undefined;

  const loadCapability = async (): Promise<RemoteAnalyticsCapability> => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      ANALYTICS_CAPABILITY_TIMEOUT_MS,
    );
    try {
      const response = await http.load(
        { path: "/version" },
        {},
        isVersionResponse,
        "Invalid server version response.",
        controller.signal,
      );
      const capabilities = response.capabilities;
      if (!capabilities || !isRouteAwareAnalyticsCapability(capabilities)) {
        return unavailableAnalyticsCapability;
      }
      return capabilities;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new StandaloneDatabaseError(
          "request-failed",
          "Server capability request timed out.",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  const waitForRefresh = async (
    refresh: Promise<RemoteAnalyticsCapability>,
    signal?: AbortSignal,
  ): Promise<RemoteAnalyticsCapability> => {
    if (signal === undefined) return refresh;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void refresh.then(
        (capability) => {
          signal.removeEventListener("abort", abort);
          resolve(capability);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  };

  return async (signal?: AbortSignal): Promise<RemoteAnalyticsCapability> => {
    const now = Date.now();
    if (
      cached &&
      now - cached.fetchedAtMs <= ANALYTICS_CAPABILITY_FRESHNESS_MS
    ) {
      return cached.capability;
    }

    let refresh = pending;
    if (refresh === undefined) {
      refresh = loadCapability().then((capability) => {
        cached = {
          capability,
          fetchedAtMs: Date.now(),
        };
        return capability;
      });
      pending = refresh;
      void refresh.then(
        () => {
          if (pending === refresh) pending = undefined;
        },
        () => {
          if (pending === refresh) pending = undefined;
        },
      );
    }

    try {
      return await waitForRefresh(refresh, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (
        cached &&
        Date.now() - cached.fetchedAtMs <= ANALYTICS_CAPABILITY_MAX_STALENESS_MS
      ) {
        return cached.capability;
      }
      throw error;
    }
  };
};
