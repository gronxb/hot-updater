import type { ConfigResponse } from "@hot-updater/cli-tools";
import { createHotUpdater } from "@hot-updater/server";
import type {
  BundleEventAnalyticsResult,
  BundleEventAnalyticsWindow,
  BundleEventSummary,
  CreateBundleEventRequest,
  InstallationHistoryRow,
  InstallationSearchRow,
  OffsetPaginationResult,
} from "@hot-updater/server/db";

export type InstallationSearchResult =
  OffsetPaginationResult<InstallationSearchRow>;
export type InstallationHistoryResult =
  OffsetPaginationResult<InstallationHistoryRow>;

export interface RuntimeHotUpdaterClient<TContext = unknown> {
  appendBundleEvent: (
    input: CreateBundleEventRequest,
    context?: TContext,
  ) => Promise<void>;
  getBundleEventSummary: (
    bundleId: string,
    context?: TContext,
  ) => Promise<BundleEventSummary>;
  getBundleEventAnalytics: (
    bundleId: string,
    window: BundleEventAnalyticsWindow,
    limit?: number,
    offset?: number,
    context?: TContext,
  ) => Promise<BundleEventAnalyticsResult>;
  searchInstallations: (
    query: string,
    limit?: number,
    offset?: number,
    context?: TContext,
  ) => Promise<InstallationSearchResult>;
  getInstallationHistory: (
    installId: string,
    limit?: number,
    offset?: number,
    context?: TContext,
  ) => Promise<InstallationHistoryResult>;
}

export function createRuntimeHotUpdater(config: ConfigResponse) {
  return createHotUpdater({
    database: config.database,
  }) as unknown as RuntimeHotUpdaterClient;
}

export async function getBundleEventSummary<TContext = unknown>(
  hotUpdater: unknown,
  bundleId: string,
  context?: TContext,
) {
  return (
    hotUpdater as RuntimeHotUpdaterClient<TContext>
  ).getBundleEventSummary(bundleId, context);
}

export async function getBundleEventAnalytics<TContext = unknown>(
  hotUpdater: unknown,
  input: {
    bundleId: string;
    window: BundleEventAnalyticsWindow;
    limit?: number;
    offset?: number;
  },
  context?: TContext,
) {
  return (
    hotUpdater as RuntimeHotUpdaterClient<TContext>
  ).getBundleEventAnalytics(
    input.bundleId,
    input.window,
    input.limit,
    input.offset,
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
  context?: TContext,
) {
  return (hotUpdater as RuntimeHotUpdaterClient<TContext>).searchInstallations(
    input.query,
    input.limit,
    input.offset,
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
  context?: TContext,
) {
  return (
    hotUpdater as RuntimeHotUpdaterClient<TContext>
  ).getInstallationHistory(input.installId, input.limit, input.offset, context);
}
