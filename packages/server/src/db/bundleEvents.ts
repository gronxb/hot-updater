import type { BundleEventRow, DatabaseWhere } from "@hot-updater/plugin-core";

import { collectActiveInstallationOverview } from "./bundleEventActiveOverview";
import { searchBundleEventInstallations } from "./bundleEventInstallationSearch";
import { createBundleEventRow } from "./bundleEventPersistence";
import { collectRecentBundleEvents } from "./bundleEventRecentScan";
import {
  collectBundleEventActivity,
  compareBundleEventNewest,
  compareCodePoints,
  materializeActiveBundleEventRows,
  materializeBundleEventRows,
} from "./bundleEventScan";
import type { BundleEventScanScope } from "./bundleEventScan";
import {
  isTransitionBundleEventRow,
  type TransitionBundleEventRow,
} from "./bundleEventTransitions";
import type {
  BundleEventAnalyticsResult,
  BundleEventAnalyticsWindow,
  BundleEventOverview,
  BundleEventSummary,
  ActiveInstallationOverview,
  ActiveInstallationWindow,
  CreateBundleEventRequest,
  DatabaseAdapter,
  InstallationHistoryRow,
  InstallationSearchRow,
  OffsetPaginationResult,
} from "./types";

const toHistoryRow = (
  row: TransitionBundleEventRow,
): InstallationHistoryRow => ({
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

const isInstalledForBundle = (
  row: BundleEventRow,
  bundleId: string,
): row is Extract<BundleEventRow, { readonly type: "UPDATE_APPLIED" }> =>
  row.type === "UPDATE_APPLIED" && row.to_bundle_id === bundleId;

const isRecoveredFromBundle = (
  row: BundleEventRow,
  bundleId: string,
): row is Extract<BundleEventRow, { readonly type: "RECOVERED" }> =>
  row.type === "RECOVERED" && row.from_bundle_id === bundleId;

const countDistinctInstallations = (rows: readonly BundleEventRow[]): number =>
  new Set(rows.map(({ install_id }) => install_id)).size;

const TRANSITION_EVENT_WHERE: readonly DatabaseWhere<"bundle_events">[] = [
  {
    field: "type",
    operator: "in",
    value: ["UPDATE_APPLIED", "RECOVERED"],
  },
];

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
        data: createBundleEventRow(input, context),
      },
      context,
    );
  },

  async getBundleEventSummary(
    bundleId: string,
    context?: TContext,
  ): Promise<BundleEventSummary> {
    const scope: BundleEventScanScope<TContext> = {
      database,
      cutoffMs: Date.now(),
      context,
    };
    const rows = await materializeBundleEventRows(
      scope,
      TRANSITION_EVENT_WHERE,
    );
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
    const rows = await materializeBundleEventRows(
      scope,
      TRANSITION_EVENT_WHERE,
    );
    const installedRows = rows.filter(
      (
        row,
      ): row is Extract<BundleEventRow, { readonly type: "UPDATE_APPLIED" }> =>
        isInstalledForBundle(row, bundleId),
    );
    const recoveredRows = rows.filter(
      (row): row is Extract<BundleEventRow, { readonly type: "RECOVERED" }> =>
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
    const rows = await materializeBundleEventRows(
      { database, cutoffMs: Date.now(), context },
      TRANSITION_EVENT_WHERE,
    );
    const latestByInstall = new Map<string, TransitionBundleEventRow>();
    for (const row of rows.filter(isTransitionBundleEventRow)) {
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

  async getActiveInstallationOverview(
    input: {
      readonly window: ActiveInstallationWindow;
      readonly userId?: string;
    },
    context?: TContext,
  ): Promise<ActiveInstallationOverview> {
    const asOfMs = Date.now();
    const rows = await materializeActiveBundleEventRows(
      { database, cutoffMs: asOfMs, context },
      input.window,
    );
    return collectActiveInstallationOverview({
      rows,
      asOfMs,
      window: input.window,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
    });
  },

  async searchInstallations(
    query: string,
    limit: number,
    offset: number,
    context?: TContext,
  ): Promise<OffsetPaginationResult<InstallationSearchRow>> {
    const rows = await materializeBundleEventRows(
      { database, cutoffMs: Date.now(), context },
      TRANSITION_EVENT_WHERE,
    );
    return searchBundleEventInstallations({
      rows: rows.filter(isTransitionBundleEventRow),
      query,
      limit,
      offset,
    });
  },

  async getInstallationHistory(
    installId: string,
    limit: number,
    offset: number,
    context?: TContext,
  ): Promise<OffsetPaginationResult<InstallationHistoryRow>> {
    const where: readonly DatabaseWhere<"bundle_events">[] = [
      { field: "install_id", value: installId },
      {
        field: "type",
        operator: "in",
        value: ["UPDATE_APPLIED", "RECOVERED"],
      },
    ];
    const rows = await materializeBundleEventRows(
      { database, cutoffMs: Date.now(), context },
      where,
    );
    const ordered = rows
      .filter(isTransitionBundleEventRow)
      .toSorted(compareBundleEventNewest);
    return {
      data: ordered.slice(offset, offset + limit).map(toHistoryRow),
      pagination: { total: ordered.length, limit, offset },
    };
  },
});
