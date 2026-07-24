import {
  defineFirstPartyFeatureManifest,
  type FeatureApiKind,
  type HotUpdaterFeatureManifest,
  type HotUpdaterPluginContribution,
} from "@hot-updater/server/internal/first-party-plugin";

import packageJson from "../package.json" with { type: "json" };
import {
  createAnalyticsFeature,
  type AnalyticsAPI,
  type AnalyticsFeatureAvailable,
} from "./api";
import { createAnalyticsMetadata } from "./metadata";
import {
  parseAnalyticsProvider,
  type AnalyticsProvider,
  type AnalyticsProviderFactory,
} from "./provider";
import { createBoundedAnalyticsProvider } from "./provider/bounded/provider";
import { createAnalyticsRoutes } from "./routes/operations";

export type { AnalyticsAPI, AnalyticsFeatureAvailable } from "./api";

export interface AnalyticsFeatureKind extends FeatureApiKind {
  readonly availableApi: AnalyticsFeatureAvailable<this["context"]>;
  readonly feature: AnalyticsFeatureAvailable<this["context"]>;
}

export type AnalyticsOptions = {
  readonly provider?: AnalyticsProviderFactory;
  readonly queryAccess?: "protected" | "public";
};

type NormalizedAnalyticsOptions = Readonly<{
  provider: AnalyticsProviderFactory;
  queryAccess: "protected" | "public";
}>;

const supportedOptionKeys = new Set(["provider", "queryAccess"]);
const createDefaultProvider: AnalyticsProviderFactory = (database) =>
  createBoundedAnalyticsProvider(database);

const isOptionsRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isAnalyticsProviderFactory = (
  value: unknown,
): value is AnalyticsProviderFactory => typeof value === "function";

const normalizeAnalyticsOptions = (
  input: unknown,
): NormalizedAnalyticsOptions => {
  if (!isOptionsRecord(input)) {
    throw new TypeError("Analytics options must be an object.");
  }
  const unknownKey = Object.keys(input).find(
    (key) => !supportedOptionKeys.has(key),
  );
  if (unknownKey !== undefined) {
    throw new TypeError(`Unsupported Analytics option: ${unknownKey}.`);
  }
  const provider = input.provider;
  if (provider !== undefined && !isAnalyticsProviderFactory(provider)) {
    throw new TypeError("Invalid Analytics provider option.");
  }
  const queryAccess = input.queryAccess;
  if (
    queryAccess !== undefined &&
    queryAccess !== "protected" &&
    queryAccess !== "public"
  ) {
    throw new TypeError("Invalid Analytics queryAccess option.");
  }
  return Object.freeze({
    provider: provider ?? createDefaultProvider,
    queryAccess: queryAccess ?? "protected",
  });
};

export const analyticsLegacyAliases = Object.freeze({
  appendBundleEvent: "appendBundleEvent",
  getActiveInstallationOverview: "getActiveInstallationOverview",
  getBundleEventAnalytics: "getBundleEventAnalytics",
  getBundleEventOverview: "getBundleEventOverview",
  getBundleEventSummary: "getBundleEventSummary",
  getInstallationHistory: "getInstallationHistory",
  searchInstallations: "searchInstallations",
} as const);

type AnalyticsAliases = typeof analyticsLegacyAliases;
type AnalyticsManifest = HotUpdaterFeatureManifest<
  "analytics",
  AnalyticsFeatureKind,
  AnalyticsAliases
>;

const createAvailableContribution = (
  provider: AnalyticsProvider,
  queryAccess: "protected" | "public",
): HotUpdaterPluginContribution<
  "analytics",
  AnalyticsFeatureKind,
  AnalyticsAliases
> =>
  Object.freeze({
    api: Object.freeze({
      legacyAliases: analyticsLegacyAliases,
      namespace: "analytics",
      value: createAnalyticsFeature<unknown>(provider),
    }),
    metadata: Object.freeze([createAnalyticsMetadata(provider)]),
    routes: createAnalyticsRoutes(provider, { queryAccess }),
  });

const createManifest = (
  options: NormalizedAnalyticsOptions,
): AnalyticsManifest => {
  const { provider: createProvider, queryAccess } = options;
  return defineFirstPartyFeatureManifest<
    "analytics",
    AnalyticsFeatureKind,
    AnalyticsAliases
  >({
    aliases: analyticsLegacyAliases,
    id: "analytics",
    namespace: "analytics",
    requires: Object.freeze([]),
    setup(context) {
      const providerCandidate = createProvider(context.database);
      void Promise.resolve(providerCandidate).catch(() => undefined);
      return createAvailableContribution(
        parseAnalyticsProvider(providerCandidate),
        queryAccess,
      );
    },
    version: packageJson.version,
  });
};

export function analytics(options?: AnalyticsOptions): AnalyticsManifest;
export function analytics(options: unknown = {}): AnalyticsManifest {
  return createManifest(normalizeAnalyticsOptions(options));
}
