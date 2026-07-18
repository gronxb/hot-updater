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
