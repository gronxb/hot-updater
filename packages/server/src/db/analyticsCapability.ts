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

export type ReportedAnalyticsCapability =
  | { readonly analytics: false }
  | ({ readonly analytics: true } & AnalyticsCapability);

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

export const resolveReportedAnalyticsCapability = async (
  api: object,
): Promise<ReportedAnalyticsCapability> => {
  const probe = Reflect.get(api, internalAnalyticsCapabilityProbe);
  if (typeof probe === "function") {
    const capability: unknown = await Reflect.apply(probe, api, []);
    return isReportedAnalyticsCapability(capability)
      ? capability
      : { analytics: false };
  }
  const capability = getAnalyticsCapability(api);
  return capability ? { analytics: true, ...capability } : { analytics: false };
};
