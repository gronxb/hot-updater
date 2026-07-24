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
  type AnalyticsFeature,
  type AnalyticsFeatureAvailable,
  type AnalyticsFeatureUnavailable,
  unavailableAnalyticsFeature,
} from "./api";
import {
  createAnalyticsMetadata,
  createUnavailableAnalyticsMetadata,
} from "./metadata";
import { analyticsProviderToken, type AnalyticsProvider } from "./provider";
import { createAnalyticsRoutes } from "./routes/operations";

export type {
  AnalyticsAPI,
  AnalyticsFeature,
  AnalyticsFeatureAvailable,
  AnalyticsFeatureUnavailable,
} from "./api";

export interface AnalyticsFeatureKind extends FeatureApiKind {
  readonly availableApi: AnalyticsFeatureAvailable<this["context"]>;
  readonly feature: AnalyticsFeature<this["context"]>;
}

export interface StrictAnalyticsFeatureKind extends FeatureApiKind {
  readonly availableApi: AnalyticsFeatureAvailable<this["context"]>;
  readonly feature: AnalyticsFeatureAvailable<this["context"]>;
}

export type AnalyticsOptions = {
  readonly missingCapability?: "error" | "warn";
  readonly queryAccess?: "protected" | "public";
};

export type StrictAnalyticsOptions = AnalyticsOptions & {
  readonly missingCapability: "error";
};

export type WarnAnalyticsOptions = AnalyticsOptions & {
  readonly missingCapability?: "warn";
};

type NormalizedAnalyticsOptions = Readonly<{
  missingCapability: "error" | "warn";
  queryAccess: "protected" | "public";
}>;

const supportedOptionKeys = new Set(["missingCapability", "queryAccess"]);

const isOptionsRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

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
  const missingCapability = input.missingCapability;
  if (
    missingCapability !== undefined &&
    missingCapability !== "error" &&
    missingCapability !== "warn"
  ) {
    throw new TypeError("Invalid Analytics missingCapability option.");
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
    missingCapability: missingCapability ?? "warn",
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
type StrictAnalyticsManifest = HotUpdaterFeatureManifest<
  "analytics",
  StrictAnalyticsFeatureKind,
  AnalyticsAliases
>;

const createAvailableContribution = <TKind extends FeatureApiKind>(
  provider: AnalyticsProvider,
  queryAccess: "protected" | "public",
): HotUpdaterPluginContribution<"analytics", TKind, AnalyticsAliases> =>
  Object.freeze({
    api: Object.freeze({
      legacyAliases: analyticsLegacyAliases,
      namespace: "analytics",
      value: createAnalyticsFeature<unknown>(provider),
    }),
    metadata: Object.freeze([createAnalyticsMetadata(provider)]),
    routes: createAnalyticsRoutes(provider, { queryAccess }),
  });

const createWarnManifest = (
  options: NormalizedAnalyticsOptions,
): AnalyticsManifest => {
  const { queryAccess } = options;
  return defineFirstPartyFeatureManifest<
    "analytics",
    AnalyticsFeatureKind,
    AnalyticsAliases
  >({
    aliases: analyticsLegacyAliases,
    id: "analytics",
    namespace: "analytics",
    requires: Object.freeze([
      Object.freeze({
        missing: "continue",
        token: analyticsProviderToken,
      }),
    ]),
    setup(context) {
      const provider = context.capabilities.get(analyticsProviderToken);
      if (provider !== undefined) {
        return createAvailableContribution<AnalyticsFeatureKind>(
          provider,
          queryAccess,
        );
      }
      context.diagnostics.warn({
        code: "ANALYTICS_PROVIDER_CAPABILITY_MISSING",
        message: "Analytics provider capability is unavailable.",
      });
      return Object.freeze({
        api: Object.freeze({
          legacyAliases: analyticsLegacyAliases,
          namespace: "analytics",
          value: unavailableAnalyticsFeature,
        }),
        metadata: Object.freeze([createUnavailableAnalyticsMetadata()]),
        routes: Object.freeze([]),
      });
    },
    version: packageJson.version,
  });
};

const createStrictManifest = (
  options: NormalizedAnalyticsOptions,
): StrictAnalyticsManifest => {
  const { queryAccess } = options;
  return defineFirstPartyFeatureManifest<
    "analytics",
    StrictAnalyticsFeatureKind,
    AnalyticsAliases
  >({
    aliases: analyticsLegacyAliases,
    id: "analytics",
    namespace: "analytics",
    requires: Object.freeze([
      Object.freeze({
        missing: "error",
        token: analyticsProviderToken,
      }),
    ]),
    setup(context) {
      return createAvailableContribution<StrictAnalyticsFeatureKind>(
        context.capabilities.require(analyticsProviderToken),
        queryAccess,
      );
    },
    version: packageJson.version,
  });
};

export function analytics(
  options: StrictAnalyticsOptions,
): StrictAnalyticsManifest;
export function analytics(options?: WarnAnalyticsOptions): AnalyticsManifest;
export function analytics(options: AnalyticsOptions): AnalyticsManifest;
export function analytics(
  options: unknown = {},
): AnalyticsManifest | StrictAnalyticsManifest {
  const normalized = normalizeAnalyticsOptions(options);
  return normalized.missingCapability === "error"
    ? createStrictManifest(normalized)
    : createWarnManifest(normalized);
}
