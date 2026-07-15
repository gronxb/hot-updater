import type { ConfigResponse } from "@hot-updater/cli-tools";
import type { HotUpdaterContext } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import {
  type BundleEventAnalyticsWindow,
  type InstallationHistoryRow,
  type InstallationSearchRow,
  type OffsetPaginationResult,
  supportsBundleEvents,
} from "@hot-updater/server/db";

export type InstallationSearchResult =
  OffsetPaginationResult<InstallationSearchRow>;
export type InstallationHistoryResult =
  OffsetPaginationResult<InstallationHistoryRow>;

export function createRuntimeHotUpdater(config: ConfigResponse) {
  return createHotUpdater({
    database: config.database,
  });
}

const requireBundleEventSupport = <TContext>(hotUpdater: unknown) => {
  if (
    typeof hotUpdater !== "object" ||
    hotUpdater === null ||
    !supportsBundleEvents<TContext>(hotUpdater)
  ) {
    throw new Error(
      "Analytics are not supported by the configured database adapter.",
    );
  }
  return hotUpdater;
};

export async function getBundleEventSummary<TContext = unknown>(
  hotUpdater: unknown,
  bundleId: string,
  context?: HotUpdaterContext<TContext>,
) {
  return requireBundleEventSupport<TContext>(hotUpdater).getBundleEventSummary(
    bundleId,
    context,
  );
}

export async function getBundleEventAnalytics<TContext = unknown>(
  hotUpdater: unknown,
  input: {
    bundleId: string;
    window: BundleEventAnalyticsWindow;
    limit?: number;
    offset?: number;
  },
  context?: HotUpdaterContext<TContext>,
) {
  return requireBundleEventSupport<TContext>(
    hotUpdater,
  ).getBundleEventAnalytics(
    input.bundleId,
    input.window,
    input.limit ?? 50,
    input.offset ?? 0,
    context,
  );
}

export async function searchInstallations<TContext = unknown>(
  hotUpdater: unknown,
  input: {
    query: string;
    limit?: number;
    offset?: number;
  },
  context?: HotUpdaterContext<TContext>,
) {
  return requireBundleEventSupport<TContext>(hotUpdater).searchInstallations(
    input.query,
    input.limit ?? 50,
    input.offset ?? 0,
    context,
  );
}

export async function getInstallationHistory<TContext = unknown>(
  hotUpdater: unknown,
  input: {
    installId: string;
    limit?: number;
    offset?: number;
  },
  context?: HotUpdaterContext<TContext>,
) {
  return requireBundleEventSupport<TContext>(hotUpdater).getInstallationHistory(
    input.installId,
    input.limit ?? 50,
    input.offset ?? 0,
    context,
  );
}
