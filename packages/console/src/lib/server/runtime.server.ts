import type {
  AnalyticsModel,
  ApiKeyModel,
  BundleRepository,
} from "@hot-updater/plugin-core";
import {
  type ActiveInstallationInput,
  type AnalyticsProvider,
  createAnalyticsProvider,
  type InstallationHistoryRow,
  type InstallationSearchRow,
  type OffsetPaginationResult,
} from "@hot-updater/server";

import {
  parseActiveInstallationInput,
  parseBundleEventAnalyticsInput,
  parseBundleEventSummaryInput,
  parseInstallationHistoryInput,
  parseSearchInstallationsInput,
} from "../analytics-input";

export type InstallationSearchResult =
  OffsetPaginationResult<InstallationSearchRow>;
export type InstallationHistoryResult =
  OffsetPaginationResult<InstallationHistoryRow>;

export function createRuntimeHotUpdater(config: {
  readonly database: BundleRepository;
}): AnalyticsProvider | null {
  const models: unknown = Reflect.get(config.database, "models");
  const analytics: unknown =
    typeof models === "object" && models !== null
      ? Reflect.get(models, "analytics")
      : undefined;
  if (
    typeof analytics !== "object" ||
    analytics === null ||
    typeof Reflect.get(analytics, "append") !== "function" ||
    typeof Reflect.get(analytics, "scan") !== "function"
  ) {
    return null;
  }
  return createAnalyticsProvider(analytics as AnalyticsModel);
}

export function createApiKeyStore(config: {
  readonly database: BundleRepository;
}): ApiKeyModel | null {
  const models: unknown = Reflect.get(config.database, "models");
  const apiKeys: unknown =
    typeof models === "object" && models !== null
      ? Reflect.get(models, "apiKeys")
      : undefined;
  if (
    typeof apiKeys !== "object" ||
    apiKeys === null ||
    typeof Reflect.get(apiKeys, "create") !== "function" ||
    typeof Reflect.get(apiKeys, "findByHash") !== "function" ||
    typeof Reflect.get(apiKeys, "list") !== "function" ||
    typeof Reflect.get(apiKeys, "revoke") !== "function"
  ) {
    return null;
  }
  return apiKeys as ApiKeyModel;
}

const providerMethods = [
  "appendBundleEvent",
  "getBundleEventSummary",
  "getBundleEventSummaries",
  "getBundleEventAnalytics",
  "getBundleEventOverview",
  "getActiveInstallationOverview",
  "searchInstallations",
  "getInstallationHistory",
] as const;

const parseAnalyticsProvider = (value: unknown): AnalyticsProvider | null => {
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "mode") !== "bounded" ||
    typeof Reflect.get(value, "maxMatchingRows") !== "number" ||
    !providerMethods.every(
      (method) => typeof Reflect.get(value, method) === "function",
    )
  ) {
    return null;
  }
  return value as AnalyticsProvider;
};

export const getAnalyticsCapability = async (provider: unknown) => {
  const parsed = parseAnalyticsProvider(provider);
  return parsed === null
    ? ({
        analytics: false,
        analyticsQueries: false,
        eventIngestion: false,
      } as const)
    : ({
        analytics: true,
        analyticsQueries: true,
        eventIngestion: true,
        maxMatchingRows: parsed.maxMatchingRows,
        mode: "bounded",
      } as const);
};

const requireAnalyticsSupport = async (
  provider: unknown,
): Promise<AnalyticsProvider> => {
  const parsedProvider = parseAnalyticsProvider(provider);
  if (parsedProvider === null) {
    throw new Error(
      "Analytics are not supported by the configured database plugin.",
    );
  }
  return parsedProvider;
};

export async function getBundleEventSummary(provider: unknown, input: unknown) {
  const { bundleId } = parseBundleEventSummaryInput(input);
  return (await requireAnalyticsSupport(provider)).getBundleEventSummary(
    bundleId,
  );
}

export async function getActiveInstallationOverview(
  provider: unknown,
  input: unknown,
) {
  const parsed: ActiveInstallationInput = parseActiveInstallationInput(input);
  return (
    await requireAnalyticsSupport(provider)
  ).getActiveInstallationOverview(parsed);
}

export async function getBundleEventAnalytics(
  provider: unknown,
  input: unknown,
) {
  const parsed = parseBundleEventAnalyticsInput(input);
  return (await requireAnalyticsSupport(provider)).getBundleEventAnalytics(
    parsed.bundleId,
    parsed.window,
    parsed.limit ?? 50,
    parsed.offset ?? 0,
  );
}

export async function searchInstallations(provider: unknown, input: unknown) {
  const parsed = parseSearchInstallationsInput(input);
  return (await requireAnalyticsSupport(provider)).searchInstallations(
    parsed.query,
    parsed.limit ?? 50,
    parsed.offset ?? 0,
  );
}

export async function getInstallationHistory(
  provider: unknown,
  input: unknown,
) {
  const parsed = parseInstallationHistoryInput(input);
  return (await requireAnalyticsSupport(provider)).getInstallationHistory(
    parsed.installId,
    parsed.limit ?? 50,
    parsed.offset ?? 0,
  );
}
