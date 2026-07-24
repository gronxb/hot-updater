import {
  analytics,
  type InstallationHistoryRow,
  type InstallationSearchRow,
  type OffsetPaginationResult,
} from "@hot-updater/analytics";
import type { ConfigResponse } from "@hot-updater/cli-tools";
import type { HotUpdaterContext } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  isFirstPartyFeatureManifest,
  type FirstPartyFeatureManifest,
} from "@hot-updater/server/internal/first-party-plugin";

import {
  parseActiveInstallationInput,
  parseBundleEventAnalyticsInput,
  parseBundleEventSummaryInput,
  parseInstallationHistoryInput,
  parseSearchInstallationsInput,
} from "../analytics-input";
import { getAvailableAnalyticsFeature } from "../analytics-runtime";

export type InstallationSearchResult =
  OffsetPaginationResult<InstallationSearchRow>;
export type InstallationHistoryResult =
  OffsetPaginationResult<InstallationHistoryRow>;

const resolveAnalyticsManifest = (
  configured: ConfigResponse["console"]["analytics"] | undefined,
): FirstPartyFeatureManifest | null => {
  if (configured === undefined || configured === "disabled") {
    return null;
  }
  if (configured === "database") {
    return analytics({ queryAccess: "public" });
  }
  if (
    !isFirstPartyFeatureManifest(configured) ||
    configured.id !== "analytics" ||
    configured.namespace !== "analytics"
  ) {
    throw new TypeError("Console analytics must be an Analytics manifest.");
  }
  return configured;
};

export function createRuntimeHotUpdater(config: ConfigResponse) {
  const manifest = resolveAnalyticsManifest(config.console?.analytics);
  return createHotUpdater({
    database: config.database,
    plugins: manifest === null ? [] : [manifest],
  });
}

const requireAnalyticsSupport = <TContext>(hotUpdater: unknown) => {
  const feature = getAvailableAnalyticsFeature<TContext>(hotUpdater);
  if (feature === null) {
    throw new Error(
      "Analytics are not supported by the configured database plugin.",
    );
  }
  return feature;
};

export async function getBundleEventSummary<TContext = unknown>(
  hotUpdater: unknown,
  input: unknown,
  context?: HotUpdaterContext<TContext>,
) {
  const { bundleId } = parseBundleEventSummaryInput(input);
  return requireAnalyticsSupport<TContext>(hotUpdater).getBundleEventSummary(
    bundleId,
    context,
  );
}

export async function getActiveInstallationOverview<TContext = unknown>(
  hotUpdater: unknown,
  input: unknown,
  context?: HotUpdaterContext<TContext>,
) {
  const parsed = parseActiveInstallationInput(input);
  return requireAnalyticsSupport<TContext>(
    hotUpdater,
  ).getActiveInstallationOverview(parsed, context);
}

export async function getBundleEventAnalytics<TContext = unknown>(
  hotUpdater: unknown,
  input: unknown,
  context?: HotUpdaterContext<TContext>,
) {
  const parsed = parseBundleEventAnalyticsInput(input);
  return requireAnalyticsSupport<TContext>(hotUpdater).getBundleEventAnalytics(
    parsed.bundleId,
    parsed.window,
    parsed.limit ?? 50,
    parsed.offset ?? 0,
    context,
  );
}

export async function searchInstallations<TContext = unknown>(
  hotUpdater: unknown,
  input: unknown,
  context?: HotUpdaterContext<TContext>,
) {
  const parsed = parseSearchInstallationsInput(input);
  return requireAnalyticsSupport<TContext>(hotUpdater).searchInstallations(
    parsed.query,
    parsed.limit ?? 50,
    parsed.offset ?? 0,
    context,
  );
}

export async function getInstallationHistory<TContext = unknown>(
  hotUpdater: unknown,
  input: unknown,
  context?: HotUpdaterContext<TContext>,
) {
  const parsed = parseInstallationHistoryInput(input);
  return requireAnalyticsSupport<TContext>(hotUpdater).getInstallationHistory(
    parsed.installId,
    parsed.limit ?? 50,
    parsed.offset ?? 0,
    context,
  );
}
