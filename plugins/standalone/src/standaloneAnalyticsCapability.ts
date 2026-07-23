import { createStandaloneHttp } from "./standaloneHttp";
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

const unavailableAnalyticsCapability = {
  analytics: false,
  eventIngestion: false,
  analyticsQueries: false,
} as const satisfies RemoteAnalyticsCapability;

export const internalAnalyticsCapabilityProbe = Symbol.for(
  "@hot-updater/internal/analytics-capability-probe",
);

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
    const response = await http.load(
      { path: "/version" },
      {},
      isVersionResponse,
      "Invalid server version response.",
    );
    const capabilities = response.capabilities;
    if (!capabilities || !isRouteAwareAnalyticsCapability(capabilities)) {
      return unavailableAnalyticsCapability;
    }
    return capabilities;
  };

  return async (): Promise<RemoteAnalyticsCapability> => {
    const now = Date.now();
    if (
      cached &&
      now - cached.fetchedAtMs <= ANALYTICS_CAPABILITY_FRESHNESS_MS
    ) {
      return cached.capability;
    }

    const refresh =
      pending ??
      loadCapability().then((capability) => {
        cached = {
          capability,
          fetchedAtMs: Date.now(),
        };
        return capability;
      });
    pending = refresh;

    try {
      return await refresh;
    } catch (error) {
      if (
        cached &&
        Date.now() - cached.fetchedAtMs <= ANALYTICS_CAPABILITY_MAX_STALENESS_MS
      ) {
        return cached.capability;
      }
      throw error;
    } finally {
      if (pending === refresh) {
        pending = undefined;
      }
    }
  };
};
