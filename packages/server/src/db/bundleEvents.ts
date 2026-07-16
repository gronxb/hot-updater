import { createUUIDv7 } from "@hot-updater/plugin-core";
import type { BundleEventRow, DatabaseWhere } from "@hot-updater/plugin-core";

import { searchBundleEventInstallations } from "./bundleEventInstallationSearch";
import { collectRecentBundleEvents } from "./bundleEventRecentScan";
import {
  collectBundleEventActivity,
  compareBundleEventNewest,
  compareCodePoints,
  materializeBundleEventRows,
} from "./bundleEventScan";
import type { BundleEventScanScope } from "./bundleEventScan";
import type {
  BundleEventAnalyticsResult,
  BundleEventAnalyticsWindow,
  BundleEventOverview,
  BundleEventSummary,
  CreateBundleEventRequest,
  DatabaseAdapter,
  InstallationHistoryRow,
  InstallationSearchRow,
  OffsetPaginationResult,
} from "./types";

const EVENT_HEADER = "Hot-Updater-SDK-Version";

const toHistoryRow = (row: BundleEventRow): InstallationHistoryRow => ({
  id: row.id,
  type: row.type,
  fromBundleId: row.from_bundle_id,
  toBundleId: row.to_bundle_id,
  username: row.username,
  userId: row.user_id,
  platform: row.platform,
  appVersion: row.app_version,
  channel: row.channel,
  cohort: row.cohort,
  receivedAtMs: row.received_at_ms,
});

const getSdkVersion = (
  input: CreateBundleEventRequest,
  context: unknown,
): string | null => {
  const sdkVersion = Reflect.get(input, "sdkVersion");
  if (typeof sdkVersion === "string" || sdkVersion === null) {
    return sdkVersion ?? null;
  }
  if (typeof context !== "object" || context === null) return null;
  const request = Reflect.get(context, "request");
  return request instanceof Request ? request.headers.get(EVENT_HEADER) : null;
};

const isInstalledForBundle = (row: BundleEventRow, bundleId: string): boolean =>
  row.type === "UPDATE_APPLIED" && row.to_bundle_id === bundleId;

const isRecoveredFromBundle = (
  row: BundleEventRow,
  bundleId: string,
): boolean => row.type === "RECOVERED" && row.from_bundle_id === bundleId;

const countDistinctInstallations = (rows: readonly BundleEventRow[]): number =>
  new Set(rows.map(({ install_id }) => install_id)).size;

export const createBundleEventService = <TContext>(
  database: DatabaseAdapter<TContext>,
) => ({
  async appendBundleEvent(
    input: CreateBundleEventRequest,
    context?: TContext,
  ): Promise<void> {
    await database.create(
      {
        model: "bundle_events",
        data: {
          id: createUUIDv7(),
          type: input.type,
          install_id: input.installId,
          user_id: input.userId ?? null,
          username: input.username ?? null,
          from_bundle_id: input.fromBundleId,
          to_bundle_id: input.toBundleId,
          platform: input.platform,
          app_version: input.appVersion,
          channel: input.channel,
          cohort: input.cohort,
          update_strategy: input.updateStrategy,
          fingerprint_hash: input.fingerprintHash,
          sdk_version: getSdkVersion(input, context),
          received_at_ms: Date.now(),
        },
      },
      context,
    );
  },

  async getBundleEventSummary(
    bundleId: string,
    context?: TContext,
  ): Promise<BundleEventSummary> {
    const rows = await materializeBundleEventRows({
      database,
      cutoffMs: Date.now(),
      context,
    });
    return {
      installed: countDistinctInstallations(
        rows.filter((row) => isInstalledForBundle(row, bundleId)),
      ),
      recovered: countDistinctInstallations(
        rows.filter((row) => isRecoveredFromBundle(row, bundleId)),
      ),
    };
  },

  async getBundleEventAnalytics(
    bundleId: string,
    window: BundleEventAnalyticsWindow,
    limit: number,
    offset: number,
    context?: TContext,
  ): Promise<BundleEventAnalyticsResult> {
    const scope: BundleEventScanScope<TContext> = {
      database,
      cutoffMs: Date.now(),
      context,
    };
    const rows = await materializeBundleEventRows(scope);
    const installedRows = rows.filter((row) =>
      isInstalledForBundle(row, bundleId),
    );
    const recoveredRows = rows.filter((row) =>
      isRecoveredFromBundle(row, bundleId),
    );
    const installed = collectBundleEventActivity({
      rows: installedRows,
      window,
      cutoffMs: scope.cutoffMs,
    });
    const recovered = collectBundleEventActivity({
      rows: recoveredRows,
      window,
      cutoffMs: scope.cutoffMs,
    });
    const recent = collectRecentBundleEvents({
      rows: [...installedRows, ...recoveredRows],
      limit,
      offset,
    });
    return {
      summary: { installed: installed.summary, recovered: recovered.summary },
      series: { installed: installed.series, recovered: recovered.series },
      cohorts: { installed: installed.cohorts, recovered: recovered.cohorts },
      recentEvents: {
        data: recent.rows.map(toHistoryRow),
        pagination: { total: recent.total, limit, offset },
      },
    };
  },

  async getBundleEventOverview(
    context?: TContext,
  ): Promise<BundleEventOverview> {
    const rows = await materializeBundleEventRows({
      database,
      cutoffMs: Date.now(),
      context,
    });
    const latestByInstall = new Map<string, BundleEventRow>();
    for (const row of rows) {
      const current = latestByInstall.get(row.install_id);
      if (!current || compareBundleEventNewest(row, current) < 0) {
        latestByInstall.set(row.install_id, row);
      }
    }
    const counts = new Map<string, number>();
    for (const row of latestByInstall.values()) {
      counts.set(row.to_bundle_id, (counts.get(row.to_bundle_id) ?? 0) + 1);
    }
    return {
      trackedInstallations: latestByInstall.size,
      bundles: [...counts]
        .map(([bundleId, installations]) => ({ bundleId, installations }))
        .sort(
          (left, right) =>
            right.installations - left.installations ||
            compareCodePoints(left.bundleId, right.bundleId),
        ),
    };
  },

  async searchInstallations(
    query: string,
    limit: number,
    offset: number,
    context?: TContext,
  ): Promise<OffsetPaginationResult<InstallationSearchRow>> {
    const rows = await materializeBundleEventRows({
      database,
      cutoffMs: Date.now(),
      context,
    });
    return searchBundleEventInstallations({ rows, query, limit, offset });
  },

  async getInstallationHistory(
    installId: string,
    limit: number,
    offset: number,
    context?: TContext,
  ): Promise<OffsetPaginationResult<InstallationHistoryRow>> {
    const where: readonly DatabaseWhere<"bundle_events">[] = [
      { field: "install_id", value: installId },
    ];
    const rows = await materializeBundleEventRows(
      { database, cutoffMs: Date.now(), context },
      where,
    );
    const ordered = [...rows].sort(compareBundleEventNewest);
    return {
      data: ordered.slice(offset, offset + limit).map(toHistoryRow),
      pagination: { total: ordered.length, limit, offset },
    };
  },
});
