import type { AnalyticsFeatureAvailable } from "@hot-updater/analytics";

const ANALYTICS_METHODS = Object.freeze([
  "appendBundleEvent",
  "getActiveInstallationOverview",
  "getBundleEventAnalytics",
  "getBundleEventOverview",
  "getBundleEventSummary",
  "getInstallationHistory",
  "searchInstallations",
] as const);

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const isAvailableAnalyticsFeature = <TContext>(
  value: unknown,
): value is AnalyticsFeatureAvailable<TContext> =>
  isObject(value) &&
  Reflect.get(value, "status") === "available" &&
  ANALYTICS_METHODS.every(
    (method) => typeof Reflect.get(value, method) === "function",
  );

export const getAvailableAnalyticsFeature = <TContext>(
  runtime: unknown,
): AnalyticsFeatureAvailable<TContext> | null => {
  if (!isObject(runtime)) return null;
  const features = Reflect.get(runtime, "features");
  if (!isObject(features)) return null;
  const feature = Reflect.get(features, "analytics");
  return isAvailableAnalyticsFeature<TContext>(feature) ? feature : null;
};

export type AnalyticsKernelRuntime = {
  readonly basePath: string;
  readonly handler: (request: Request) => Promise<Response>;
};

export const isAnalyticsKernelRuntime = (
  runtime: unknown,
): runtime is AnalyticsKernelRuntime =>
  isObject(runtime) &&
  typeof Reflect.get(runtime, "basePath") === "string" &&
  typeof Reflect.get(runtime, "handler") === "function";
