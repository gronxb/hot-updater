import { createUUIDv7, type BundleEventRow } from "@hot-updater/plugin-core";

import type {
  BundleEventAnalyticsResult,
  BundleEventAnalyticsWindow,
  BundleEventSummary,
  CreateBundleEventRequest,
  DatabaseAdapter,
  InstallationHistoryRow,
  InstallationSearchRow,
  OffsetPaginationResult,
} from "./types";

const EVENT_HEADER = "Hot-Updater-SDK-Version";

type InternalCreateBundleEventRequest = CreateBundleEventRequest & {
  sdkVersion?: string | null;
};

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

const toSearchRow = (row: BundleEventRow): InstallationSearchRow => ({
  installId: row.install_id,
  username: row.username,
  userId: row.user_id,
  lastKnownBundleId: row.to_bundle_id,
  latestStatus: row.type,
  platform: row.platform,
  appVersion: row.app_version,
  channel: row.channel,
  cohort: row.cohort,
  receivedAtMs: row.received_at_ms,
});

const getEventOrderBy = (): readonly [
  { readonly field: "received_at_ms"; readonly direction: "desc" },
  { readonly field: "id"; readonly direction: "desc" },
] => [
  { field: "received_at_ms", direction: "desc" },
  { field: "id", direction: "desc" },
];

const getLatestPerInstallOrderBy = (): readonly [
  { readonly field: "install_id"; readonly direction: "asc" },
  { readonly field: "received_at_ms"; readonly direction: "desc" },
  { readonly field: "id"; readonly direction: "desc" },
] => [
  { field: "install_id", direction: "asc" },
  { field: "received_at_ms", direction: "desc" },
  { field: "id", direction: "desc" },
];

const getSdkVersion = (
  input: InternalCreateBundleEventRequest,
  context: unknown,
): string | null => {
  if (typeof input.sdkVersion === "string" || input.sdkVersion === null) {
    return input.sdkVersion ?? null;
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
  any: [
    { field: "type", value: "UPDATE_APPLIED" as const },
    { field: "to_bundle_id", value: bundleId },
    {
      field: "type",
      operator: "eq" as const,
      value: "RECOVERED" as const,
      connector: "OR" as const,
    },
    { field: "from_bundle_id", value: bundleId },
  ] as const,
});

const startOfUtcHour = (value: number): number => {
  const date = new Date(value);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
  );
};

const startOfUtcDay = (value: number): number => {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

const createBuckets = (
  window: BundleEventAnalyticsWindow,
  oldestMatchingMs: number | undefined,
  now: number,
): {
  readonly sizeMs: number;
  readonly starts: number[];
  readonly rangeStart: number;
} => {
  const currentHour = startOfUtcHour(now);
  const currentDay = startOfUtcDay(now);
  if (window === "24h") {
    return {
      sizeMs: 60 * 60 * 1000,
      rangeStart: currentHour - 23 * 60 * 60 * 1000,
      starts: Array.from(
        { length: 24 },
        (_, index) => currentHour - (23 - index) * 60 * 60 * 1000,
      ),
    };
  }
  if (window === "7d") {
    return {
      sizeMs: 24 * 60 * 60 * 1000,
      rangeStart: currentDay - 6 * 24 * 60 * 60 * 1000,
      starts: Array.from(
        { length: 7 },
        (_, index) => currentDay - (6 - index) * 24 * 60 * 60 * 1000,
      ),
    };
  }
  if (window === "30d") {
    return {
      sizeMs: 24 * 60 * 60 * 1000,
      rangeStart: currentDay - 29 * 24 * 60 * 60 * 1000,
      starts: Array.from(
        { length: 30 },
        (_, index) => currentDay - (29 - index) * 24 * 60 * 60 * 1000,
      ),
    };
  }
  const start =
    oldestMatchingMs === undefined
      ? currentDay
      : startOfUtcDay(oldestMatchingMs);
  const days = Math.max(
    1,
    Math.floor((currentDay - start) / (24 * 60 * 60 * 1000)) + 1,
  );
  return {
    sizeMs: 24 * 60 * 60 * 1000,
    rangeStart: start,
    starts: Array.from(
      { length: days },
      (_, index) => start + index * 24 * 60 * 60 * 1000,
    ),
  };
};

const buildCumulativeSeries = (
  rows: readonly BundleEventRow[],
  window: BundleEventAnalyticsWindow,
  now: number,
): { bucketStartMs: number; value: number }[] => {
  const oldest = rows.at(-1)?.received_at_ms;
  const buckets = createBuckets(window, oldest, now);
  const counts = new Map<number, number>(
    buckets.starts.map((start) => [start, 0] as const),
  );
  const seen = new Set<string>();
  for (const row of rows.toReversed()) {
    if (seen.has(row.install_id)) continue;
    seen.add(row.install_id);
    const bucketStart =
      buckets.sizeMs === 60 * 60 * 1000
        ? startOfUtcHour(row.received_at_ms)
        : startOfUtcDay(row.received_at_ms);
    if (bucketStart < buckets.rangeStart || !counts.has(bucketStart)) continue;
    counts.set(bucketStart, (counts.get(bucketStart) ?? 0) + 1);
  }
  let total = 0;
  return buckets.starts.map((bucketStartMs) => {
    total += counts.get(bucketStartMs) ?? 0;
    return { bucketStartMs, value: total };
  });
};

const buildCohortCounts = (rows: readonly BundleEventRow[]) =>
  [
    ...rows
      .reduce(
        (map, row) => {
          const key = `${row.cohort}\0${row.install_id}`;
          if (map.seen.has(key)) return map;
          map.seen.add(key);
          map.counts.set(row.cohort, (map.counts.get(row.cohort) ?? 0) + 1);
          return map;
        },
        { counts: new Map<string, number>(), seen: new Set<string>() },
      )
      .counts.entries(),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cohort, value]) => ({ cohort, value }));

const fetchAllBundleEvents = async <TContext>(
  database: DatabaseAdapter<TContext>,
  where: readonly any[],
  context?: TContext,
): Promise<BundleEventRow[]> => {
  const total = await database.count(
    { model: "bundle_events", where },
    context,
  );
  if (total === 0) return [];
  const rows = await database.findMany(
    {
      model: "bundle_events",
      where,
      orderBy: getEventOrderBy(),
      limit: total,
      offset: 0,
    },
    context,
  );
  return rows as BundleEventRow[];
};

const fetchLatestRowsForInstalls = async <TContext>(
  database: DatabaseAdapter<TContext>,
  installIds: readonly string[],
  context?: TContext,
): Promise<BundleEventRow[]> => {
  if (installIds.length === 0) return [];
  const rows = await database.findMany(
    {
      model: "bundle_events",
      where: [{ field: "install_id", operator: "in", value: installIds }],
      distinctOn: { fields: ["install_id"] },
      orderBy: getLatestPerInstallOrderBy(),
      limit: installIds.length,
      offset: 0,
    },
    context,
  );
  return (rows as BundleEventRow[]).toSorted(
    (left, right) =>
      right.received_at_ms - left.received_at_ms ||
      right.id.localeCompare(left.id),
  );
};

export const createBundleEventService = <TContext>(
  database: DatabaseAdapter<TContext>,
) => ({
  async appendBundleEvent(
    input: CreateBundleEventRequest,
    context?: TContext,
  ): Promise<void> {
    const internal = input as InternalCreateBundleEventRequest;
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
          sdk_version: getSdkVersion(internal, context),
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
      database.count(
        {
          model: "bundle_events",
          where: where.installed,
          distinct: ["install_id"],
        },
        context,
      ),
      database.count(
        {
          model: "bundle_events",
          where: where.recovered,
          distinct: ["install_id"],
        },
        context,
      ),
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
    const [summary, installedRows, recoveredRows] = await Promise.all([
      this.getBundleEventSummary(bundleId, context),
      fetchAllBundleEvents(database, where.installed, context),
      fetchAllBundleEvents(database, where.recovered, context),
    ]);
    const combinedRows = [...installedRows, ...recoveredRows].toSorted(
      (left, right) =>
        right.received_at_ms - left.received_at_ms ||
        right.id.localeCompare(left.id),
    );
    const recentRows = combinedRows.slice(offset, offset + limit);
    const now = Date.now();
    return {
      summary,
      series: {
        installed: buildCumulativeSeries(installedRows, window, now),
        recovered: buildCumulativeSeries(recoveredRows, window, now),
      },
      cohorts: {
        installed: buildCohortCounts(installedRows),
        recovered: buildCohortCounts(recoveredRows),
      },
      recentEvents: {
        data: recentRows.map(toHistoryRow),
        pagination: {
          total: combinedRows.length,
          limit,
          offset,
        },
      },
    };
  },

  async searchInstallations(
    query: string,
    limit: number,
    offset: number,
    context?: TContext,
  ): Promise<OffsetPaginationResult<InstallationSearchRow>> {
    const total = await database.count(
      {
        model: "bundle_events",
        where: [
          {
            field: "username",
            operator: "contains",
            value: query,
            mode: "insensitive",
          },
          {
            field: "user_id",
            operator: "contains",
            value: query,
            mode: "insensitive",
            connector: "OR",
          },
          {
            field: "install_id",
            operator: "contains",
            value: query,
            mode: "insensitive",
            connector: "OR",
          },
        ],
        distinct: ["install_id"],
      },
      context,
    );
    if (total === 0) {
      return { data: [], pagination: { total: 0, limit, offset } };
    }
    const matchingRows = await database.findMany(
      {
        model: "bundle_events",
        where: [
          {
            field: "username",
            operator: "contains",
            value: query,
            mode: "insensitive",
          },
          {
            field: "user_id",
            operator: "contains",
            value: query,
            mode: "insensitive",
            connector: "OR",
          },
          {
            field: "install_id",
            operator: "contains",
            value: query,
            mode: "insensitive",
            connector: "OR",
          },
        ],
        distinctOn: { fields: ["install_id"] },
        orderBy: getLatestPerInstallOrderBy(),
        limit: total,
        offset: 0,
      },
      context,
    );
    const latestRows = await fetchLatestRowsForInstalls(
      database,
      (matchingRows as BundleEventRow[]).map((row) => row.install_id),
      context,
    );
    return {
      data: latestRows.slice(offset, offset + limit).map(toSearchRow),
      pagination: {
        total,
        limit,
        offset,
      },
    };
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
          orderBy: getEventOrderBy(),
          limit,
          offset,
        },
        context,
      ) as Promise<BundleEventRow[]>,
    ]);
    return {
      data: rows.map(toHistoryRow),
      pagination: { total, limit, offset },
    };
  },
});
