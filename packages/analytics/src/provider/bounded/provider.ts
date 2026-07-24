import type {
  DatabaseCapabilityRuntime,
  DatabaseRow,
  DatabaseWhere,
} from "@hot-updater/plugin-core";

import type {
  BundleEventAnalyticsWindow,
  InstallationHistoryRow,
} from "../../domain";
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

type BundleEventRow = DatabaseRow<"bundle_events">;
type TransitionEventRow = Exclude<
  BundleEventRow,
  { readonly type: "UNCHANGED" }
>;

const isTransitionEventRow = (row: BundleEventRow): row is TransitionEventRow =>
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

const getAnalyticsResult = async (
  database: DatabaseCapabilityRuntime,
  bundleId: string,
  window: BundleEventAnalyticsWindow,
  limit: number,
  offset: number,
) => {
  const scope = { database, cutoffMs: Date.now() };
  const rows = await materializeRowsForWindow(
    scope,
    window,
    TRANSITION_EVENT_WHERE,
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

export const createBoundedAnalyticsProvider = (
  database: DatabaseCapabilityRuntime,
): AnalyticsProvider =>
  Object.freeze({
    mode: "bounded",
    maxMatchingRows: ANALYTICS_SCAN_MAX_ROWS,
    async appendBundleEvent(input) {
      await database.create({
        model: "bundle_events",
        data: createBundleEventRow(input),
      });
    },
    async getBundleEventSummary(bundleId) {
      const rows = await materializeEventRows(
        { database, cutoffMs: Date.now() },
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
    getBundleEventAnalytics(bundleId, window, limit, offset) {
      return getAnalyticsResult(database, bundleId, window, limit, offset);
    },
    async getBundleEventOverview() {
      const rows = await materializeEventRows(
        { database, cutoffMs: Date.now() },
        TRANSITION_EVENT_WHERE,
      );
      const latestByInstall = new Map<string, TransitionEventRow>();
      for (const row of rows.filter(isTransitionEventRow)) {
        const current = latestByInstall.get(row.install_id);
        if (!current || compareEventNewest(row, current) < 0) {
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
    async getActiveInstallationOverview(input) {
      const asOfMs = Date.now();
      const rows = await materializeActiveRows(
        { database, cutoffMs: asOfMs },
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
        database,
        cutoffMs: Date.now(),
      });
      return searchEventInstallations({ rows, query, limit, offset });
    },
    async getInstallationHistory(installId, limit, offset) {
      const where: readonly DatabaseWhere<"bundle_events">[] = [
        { field: "install_id", value: installId },
        {
          field: "type",
          operator: "in",
          value: ["UPDATE_APPLIED", "RECOVERED"],
        },
      ];
      const rows = await materializeEventRows(
        { database, cutoffMs: Date.now() },
        where,
      );
      const ordered = rows
        .filter(isTransitionEventRow)
        .toSorted(compareEventNewest);
      return {
        data: ordered.slice(offset, offset + limit).map(toHistoryRow),
        pagination: { total: ordered.length, limit, offset },
      };
    },
  } satisfies AnalyticsProvider);
