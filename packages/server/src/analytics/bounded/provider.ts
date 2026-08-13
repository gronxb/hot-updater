import type {
  BundleEventAnalyticsWindow,
  InstallationHistoryRow,
} from "../domain";
import type {
  AnalyticsPersistence,
  BundleEventPersistenceRow,
} from "../persistence";
import type { AnalyticsProvider } from "../types";
import { collectActiveInstallationOverview } from "./activeOverview";
import { searchEventInstallations } from "./installationSearch";
import { createBundleEventRow } from "./persistence";
import {
  ANALYTICS_SCAN_MAX_ROWS,
  collectEventActivity,
  compareCodePoints,
  compareEventNewest,
  materializeActiveRows,
  materializeEventRows,
  materializeRowsForWindow,
} from "./scan";

type TransitionEventRow = BundleEventPersistenceRow & {
  readonly type: "UPDATE_APPLIED" | "RECOVERED";
};

const isTransitionEventRow = (
  row: BundleEventPersistenceRow,
): row is TransitionEventRow =>
  row.type === "UPDATE_APPLIED" || row.type === "RECOVERED";

const toHistoryRow = (row: TransitionEventRow): InstallationHistoryRow => ({
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
  row: TransitionEventRow,
  bundleId: string,
): boolean => row.type === "UPDATE_APPLIED" && row.to_bundle_id === bundleId;

const isRecoveredFromBundle = (
  row: TransitionEventRow,
  bundleId: string,
): boolean => row.type === "RECOVERED" && row.from_bundle_id === bundleId;

const countDistinctInstallations = (
  rows: readonly BundleEventPersistenceRow[],
): number => new Set(rows.map(({ install_id }) => install_id)).size;

const getAnalyticsResult = async (
  persistence: AnalyticsPersistence,
  bundleId: string,
  window: BundleEventAnalyticsWindow,
  limit: number,
  offset: number,
) => {
  const scope = { persistence, cutoffMs: Date.now() };
  const rows = (await materializeRowsForWindow(scope, window)).filter(
    isTransitionEventRow,
  );
  const installedRows = rows.filter((row) =>
    isInstalledForBundle(row, bundleId),
  );
  const recoveredRows = rows.filter((row) =>
    isRecoveredFromBundle(row, bundleId),
  );
  const installed = collectEventActivity({
    rows: installedRows,
    window,
    cutoffMs: scope.cutoffMs,
  });
  const recovered = collectEventActivity({
    rows: recoveredRows,
    window,
    cutoffMs: scope.cutoffMs,
  });
  const recentRows = [...installedRows, ...recoveredRows].sort(
    compareEventNewest,
  );
  return {
    summary: { installed: installed.summary, recovered: recovered.summary },
    series: { installed: installed.series, recovered: recovered.series },
    cohorts: { installed: installed.cohorts, recovered: recovered.cohorts },
    recentEvents: {
      data: recentRows.slice(offset, offset + limit).map(toHistoryRow),
      pagination: { total: recentRows.length, limit, offset },
    },
  };
};

export const createAnalyticsProvider = (
  persistence: AnalyticsPersistence,
): AnalyticsProvider =>
  Object.freeze({
    mode: "bounded",
    maxMatchingRows: ANALYTICS_SCAN_MAX_ROWS,
    async appendBundleEvent(input) {
      await persistence.append(createBundleEventRow(input));
    },
    async getBundleEventSummary(bundleId) {
      const rows = (
        await materializeEventRows({ persistence, cutoffMs: Date.now() })
      ).filter(isTransitionEventRow);
      return {
        installed: countDistinctInstallations(
          rows.filter((row) => isInstalledForBundle(row, bundleId)),
        ),
        recovered: countDistinctInstallations(
          rows.filter((row) => isRecoveredFromBundle(row, bundleId)),
        ),
      };
    },
    getBundleEventAnalytics(bundleId, window, limit, offset) {
      return getAnalyticsResult(persistence, bundleId, window, limit, offset);
    },
    async getBundleEventOverview() {
      const rows = await materializeEventRows({
        persistence,
        cutoffMs: Date.now(),
      });
      const latestByInstall = new Map<string, BundleEventPersistenceRow>();
      for (const row of rows) {
        const current = latestByInstall.get(row.install_id);
        if (current === undefined || compareEventNewest(row, current) < 0) {
          latestByInstall.set(row.install_id, row);
        }
      }
      const counts = new Map<string, number>();
      for (const row of latestByInstall.values()) {
        if (row.to_bundle_id === null) continue;
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
    async getActiveInstallationOverview(input) {
      const asOfMs = Date.now();
      const rows = await materializeActiveRows(
        { persistence, cutoffMs: asOfMs },
        input.window,
      );
      return collectActiveInstallationOverview({
        rows,
        asOfMs,
        window: input.window,
        ...(input.userId === undefined ? {} : { userId: input.userId }),
      });
    },
    async searchInstallations(query, limit, offset) {
      const rows = await materializeEventRows({
        persistence,
        cutoffMs: Date.now(),
      });
      return searchEventInstallations({ rows, query, limit, offset });
    },
    async getInstallationHistory(installId, limit, offset) {
      const rows = await materializeEventRows({
        persistence,
        cutoffMs: Date.now(),
      });
      const ordered = rows
        .filter(
          (row): row is TransitionEventRow =>
            row.install_id === installId && isTransitionEventRow(row),
        )
        .toSorted(compareEventNewest);
      return {
        data: ordered.slice(offset, offset + limit).map(toHistoryRow),
        pagination: { total: ordered.length, limit, offset },
      };
    },
  } satisfies AnalyticsProvider);
