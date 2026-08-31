import type {
  InsightsModel,
  ApiKeyModel,
  BundleRepository,
} from "@hot-updater/plugin-core";
import {
  type ActiveInstallationInput,
  type InsightsProvider,
  createInsightsProvider,
  type InstallationHistoryRow,
  type InstallationSearchRow,
  type OffsetPaginationResult,
} from "@hot-updater/server";

import {
  parseActiveInstallationInput,
  parseBundleEventInsightsInput,
  parseBundleEventSummaryInput,
  parseEventHistoryInput,
  parseInstallationHistoryInput,
  parseSearchInstallationsInput,
} from "../insights-input";

export type InstallationSearchResult =
  OffsetPaginationResult<InstallationSearchRow>;
export type InstallationHistoryResult =
  OffsetPaginationResult<InstallationHistoryRow>;

export function createRuntimeHotUpdater(config: {
  readonly database: BundleRepository;
}): InsightsProvider | null {
  const models: unknown = Reflect.get(config.database, "models");
  const insights: unknown =
    typeof models === "object" && models !== null
      ? Reflect.get(models, "insights")
      : undefined;
  if (
    typeof insights !== "object" ||
    insights === null ||
    typeof Reflect.get(insights, "append") !== "function" ||
    typeof Reflect.get(insights, "scan") !== "function"
  ) {
    return null;
  }
  return createInsightsProvider(insights as InsightsModel);
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
  "getBundleEventInsights",
  "getBundleEventOverview",
  "getActiveInstallationOverview",
  "searchInstallations",
  "getInstallationHistory",
  "getEventHistory",
] as const;

const parseInsightsProvider = (value: unknown): InsightsProvider | null => {
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
  return value as InsightsProvider;
};

export const getInsightsCapability = async (provider: unknown) => {
  const parsed = parseInsightsProvider(provider);
  return parsed === null
    ? ({
        insights: false,
        insightsQueries: false,
        eventIngestion: false,
      } as const)
    : ({
        insights: true,
        insightsQueries: true,
        eventIngestion: true,
        maxMatchingRows: parsed.maxMatchingRows,
        mode: "bounded",
      } as const);
};

const requireInsightsSupport = async (
  provider: unknown,
): Promise<InsightsProvider> => {
  const parsedProvider = parseInsightsProvider(provider);
  if (parsedProvider === null) {
    throw new Error(
      "Insights are not supported by the configured database plugin.",
    );
  }
  return parsedProvider;
};

export async function getBundleEventSummary(provider: unknown, input: unknown) {
  const { bundleId } = parseBundleEventSummaryInput(input);
  return (await requireInsightsSupport(provider)).getBundleEventSummary(
    bundleId,
  );
}

export async function getActiveInstallationOverview(
  provider: unknown,
  input: unknown,
) {
  const parsed: ActiveInstallationInput = parseActiveInstallationInput(input);
  return (await requireInsightsSupport(provider)).getActiveInstallationOverview(
    parsed,
  );
}

export async function getBundleEventInsights(
  provider: unknown,
  input: unknown,
) {
  const parsed = parseBundleEventInsightsInput(input);
  return (await requireInsightsSupport(provider)).getBundleEventInsights(
    parsed.bundleId,
    parsed.window,
    parsed.limit ?? 50,
    parsed.offset ?? 0,
  );
}

export async function searchInstallations(provider: unknown, input: unknown) {
  const parsed = parseSearchInstallationsInput(input);
  return (await requireInsightsSupport(provider)).searchInstallations(
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
  return (await requireInsightsSupport(provider)).getInstallationHistory(
    parsed.installId,
    parsed.limit ?? 50,
    parsed.offset ?? 0,
  );
}

export async function getEventHistory(provider: unknown, input: unknown) {
  const parsed = parseEventHistoryInput(input);
  return (await requireInsightsSupport(provider)).getEventHistory(
    parsed.limit ?? 50,
    parsed.offset ?? 0,
  );
}
