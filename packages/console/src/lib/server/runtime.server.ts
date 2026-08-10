import {
  analyticsComponentSchema,
  type ActiveInstallationInput,
  type InstallationHistoryRow,
  type InstallationSearchRow,
  type OffsetPaginationResult,
} from "@hot-updater/analytics";
import {
  createUniversalComponentAnalyticsProvider,
  type AnalyticsProvider,
  parseAnalyticsProvider,
  resolveAnalyticsCapability,
} from "@hot-updater/analytics/provider";
import {
  managedAccessKeyStoreCapability,
  type ManagedAccessKeyStore,
} from "@hot-updater/better-auth/managed";
import type { ConfigResponse } from "@hot-updater/cli-tools";
import {
  type HotUpdaterInfrastructureRuntime,
  universalComponentDataAdapterCapability,
} from "@hot-updater/plugin-core";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";

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

export function createRuntimeHotUpdater(
  config: ConfigResponse,
): AnalyticsProvider | null {
  const contribution = getCapabilityContributions(config.database).find(
    ({ token }) => token === universalComponentDataAdapterCapability,
  );
  if (!contribution) return null;

  const runtime: HotUpdaterInfrastructureRuntime = Object.freeze({
    database: config.database,
    storages: Object.freeze([]),
  });
  const adapter = universalComponentDataAdapterCapability.parse(
    Reflect.apply(contribution.create, undefined, [runtime]),
  );
  return createUniversalComponentAnalyticsProvider(
    adapter.bind(analyticsComponentSchema),
  );
}

export function createManagedAccessKeyStore(
  config: ConfigResponse,
): ManagedAccessKeyStore | null {
  const contribution = getCapabilityContributions(config.database).find(
    ({ token }) => token.id === managedAccessKeyStoreCapability.id,
  );
  if (!contribution) return null;

  return managedAccessKeyStoreCapability.parse(
    Reflect.apply(contribution.create, undefined, []),
  );
}

export const getAnalyticsCapability = async (provider: unknown) => {
  let parsedProvider: AnalyticsProvider;
  try {
    parsedProvider = parseAnalyticsProvider(provider);
  } catch {
    return {
      analytics: false,
      analyticsQueries: false,
      eventIngestion: false,
    } as const;
  }

  return resolveAnalyticsCapability(
    parsedProvider,
    new AbortController().signal,
  );
};

const requireAnalyticsSupport = async (
  provider: unknown,
): Promise<AnalyticsProvider> => {
  let parsedProvider: AnalyticsProvider;
  try {
    parsedProvider = parseAnalyticsProvider(provider);
  } catch {
    throw new Error(
      "Analytics are not supported by the configured database plugin.",
    );
  }
  const capability = await getAnalyticsCapability(provider);
  if (!capability.analytics || !capability.analyticsQueries) {
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
