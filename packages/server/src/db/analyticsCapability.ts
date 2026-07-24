import type { BundleEventAPI } from "./types";

export type AnalyticsCapability =
  | {
      readonly mode: "bounded";
      readonly maxMatchingRows: number;
    }
  | { readonly mode: "dedicated" };

export const analyticsCapabilityMetadata = Symbol.for(
  "@hot-updater/server/analytics-capability",
);

export const internalAnalyticsCapabilityProbe = Symbol.for(
  "@hot-updater/internal/analytics-capability-probe",
);

const warnedAnalyticsAPIs = new WeakSet<object>();

export const warnAnalyticsRoutesUnavailable = (api: object): void => {
  if (warnedAnalyticsAPIs.has(api)) return;
  warnedAnalyticsAPIs.add(api);
  console.warn(
    "Hot Updater Analytics routes are enabled, but the configured database or upstream does not expose the requested Analytics route.",
  );
};

export type ReportedAnalyticsCapability = (
  | { readonly analytics: false }
  | ({ readonly analytics: true } & AnalyticsCapability)
) &
  AnalyticsRouteCapability;

export type AnalyticsRouteCapability = {
  readonly eventIngestion: boolean;
  readonly analyticsQueries: boolean;
};

export const supportsAnalytics = <TContext>(
  api: object,
): api is BundleEventAPI<TContext> =>
  typeof Reflect.get(api, "appendBundleEvent") === "function" &&
  typeof Reflect.get(api, "getBundleEventSummary") === "function" &&
  typeof Reflect.get(api, "getBundleEventAnalytics") === "function" &&
  typeof Reflect.get(api, "getBundleEventOverview") === "function" &&
  typeof Reflect.get(api, "getActiveInstallationOverview") === "function" &&
  typeof Reflect.get(api, "searchInstallations") === "function" &&
  typeof Reflect.get(api, "getInstallationHistory") === "function";

export const getAnalyticsCapability = <TContext>(
  api: object,
): AnalyticsCapability | null => {
  if (!supportsAnalytics<TContext>(api)) return null;

  const metadata = Reflect.get(api, analyticsCapabilityMetadata);
  if (typeof metadata !== "object" || metadata === null) {
    return { mode: "dedicated" };
  }
  const mode = Reflect.get(metadata, "mode");
  if (mode === "dedicated") return { mode };
  const maxMatchingRows = Reflect.get(metadata, "maxMatchingRows");
  return mode === "bounded" &&
    typeof maxMatchingRows === "number" &&
    Number.isFinite(maxMatchingRows) &&
    maxMatchingRows > 0
    ? { mode, maxMatchingRows }
    : { mode: "dedicated" };
};

const isReportedAnalyticsCapability = (
  value: unknown,
): value is ReportedAnalyticsCapability => {
  if (typeof value !== "object" || value === null) return false;
  if (
    typeof Reflect.get(value, "eventIngestion") !== "boolean" ||
    typeof Reflect.get(value, "analyticsQueries") !== "boolean"
  ) {
    return false;
  }
  const analytics = Reflect.get(value, "analytics");
  if (analytics === false) return true;
  if (analytics !== true) return false;
  const mode = Reflect.get(value, "mode");
  if (mode === "dedicated") return true;
  const maxMatchingRows = Reflect.get(value, "maxMatchingRows");
  return (
    mode === "bounded" &&
    typeof maxMatchingRows === "number" &&
    Number.isFinite(maxMatchingRows) &&
    maxMatchingRows > 0
  );
};

export const resolveAnalyticsRouteAPI = async <TContext>(
  api: object,
  route: keyof AnalyticsRouteCapability,
): Promise<BundleEventAPI<TContext> | null> => {
  if (!supportsAnalytics<TContext>(api)) return null;
  const probe = Reflect.get(api, internalAnalyticsCapabilityProbe);
  if (typeof probe !== "function") return api;
  const capability: unknown = await Reflect.apply(probe, api, []);
  if (
    isReportedAnalyticsCapability(capability) &&
    capability.analytics &&
    capability[route]
  ) {
    return api;
  }
  warnAnalyticsRoutesUnavailable(api);
  return null;
};

export const resolveReportedAnalyticsCapability = async (
  api: object,
  eventIngestionMounted: boolean,
  analyticsQueriesMounted: boolean,
): Promise<ReportedAnalyticsCapability> => {
  const probe = Reflect.get(api, internalAnalyticsCapabilityProbe);
  if (typeof probe === "function") {
    const capability: unknown = await Reflect.apply(probe, api, []);
    if (!isReportedAnalyticsCapability(capability) || !capability.analytics) {
      return {
        analytics: false,
        eventIngestion: false,
        analyticsQueries: false,
      };
    }
    return {
      ...capability,
      eventIngestion: capability.eventIngestion && eventIngestionMounted,
      analyticsQueries: capability.analyticsQueries && analyticsQueriesMounted,
    };
  }
  const capability = getAnalyticsCapability(api);
  return capability
    ? {
        analytics: true,
        ...capability,
        eventIngestion: eventIngestionMounted,
        analyticsQueries: analyticsQueriesMounted,
      }
    : {
        analytics: false,
        eventIngestion: eventIngestionMounted,
        analyticsQueries: analyticsQueriesMounted,
      };
};
