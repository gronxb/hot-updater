import { createUUIDv7 } from "@hot-updater/plugin-core";
import type { BundleEventRow } from "@hot-updater/plugin-core";

import { searchBundleEventInstallations } from "./bundleEventInstallationSearch";
import {
  latestInstallOrder,
  newestEventOrder,
  scanBundleEventActivity,
  scanBundleEventRows,
  scanDistinctInstallations,
  scanRecentBundleEvents,
} from "./bundleEventScan";
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

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

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
  if (typeof context !== "object" || context === null) {
    return null;
  }
  const request = Reflect.get(context, "request");
  if (!(request instanceof Request)) {
    return null;
  }
  return request.headers.get(EVENT_HEADER);
};

const createWhereForBundle = (bundleId: string) => ({
  installed: [
    { field: "type", value: "UPDATE_APPLIED" as const },
    { field: "to_bundle_id", value: bundleId },
  ] as const,
  recovered: [
    { field: "type", value: "RECOVERED" as const },
    { field: "from_bundle_id", value: bundleId },
  ] as const,
});

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
    const where = createWhereForBundle(bundleId);
    const [installed, recovered] = await Promise.all([
      scanDistinctInstallations(database, where.installed, context),
      scanDistinctInstallations(database, where.recovered, context),
    ]);
    return { installed, recovered };
  },

  async getBundleEventAnalytics(
    bundleId: string,
    window: BundleEventAnalyticsWindow,
    limit: number,
    offset: number,
    context?: TContext,
  ): Promise<BundleEventAnalyticsResult> {
    const where = createWhereForBundle(bundleId);
    const now = Date.now();
    const [installed, recovered, recent] = await Promise.all([
      scanBundleEventActivity(database, where.installed, window, now, context),
      scanBundleEventActivity(database, where.recovered, window, now, context),
      scanRecentBundleEvents(
        database,
        where.installed,
        where.recovered,
        limit,
        offset,
        context,
      ),
    ]);
    return {
      summary: {
        installed: installed.summary,
        recovered: recovered.summary,
      },
      series: {
        installed: installed.series,
        recovered: recovered.series,
      },
      cohorts: {
        installed: installed.cohorts,
        recovered: recovered.cohorts,
      },
      recentEvents: {
        data: recent.rows.map(toHistoryRow),
        pagination: {
          total: recent.total,
          limit,
          offset,
        },
      },
    };
  },

  async getBundleEventOverview(
    context?: TContext,
  ): Promise<BundleEventOverview> {
    const counts = new Map<string, number>();
    let previousInstallId: string | undefined;
    let trackedInstallations = 0;
    for await (const row of scanBundleEventRows(
      database,
      { orderBy: latestInstallOrder },
      context,
    )) {
      if (row.install_id === previousInstallId) continue;
      previousInstallId = row.install_id;
      trackedInstallations += 1;
      counts.set(row.to_bundle_id, (counts.get(row.to_bundle_id) ?? 0) + 1);
    }
    return {
      trackedInstallations,
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
    return searchBundleEventInstallations(
      database,
      query,
      limit,
      offset,
      context,
    );
  },

  async getInstallationHistory(
    installId: string,
    limit: number,
    offset: number,
    context?: TContext,
  ): Promise<OffsetPaginationResult<InstallationHistoryRow>> {
    const where = [{ field: "install_id", value: installId }] as const;
    const [total, rows] = await Promise.all([
      database.count({ model: "bundle_events", where }, context),
      database.findMany(
        {
          model: "bundle_events",
          where,
          orderBy: newestEventOrder,
          limit,
          offset,
        },
        context,
      ),
    ]);
    return {
      data: rows.map(toHistoryRow),
      pagination: { total, limit, offset },
    };
  },
});
