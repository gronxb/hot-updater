import {
  compareUtf8,
  countDistinct,
  DatabaseAdapterInputError,
  mergeDistinct,
  type HotUpdaterDatabase,
  type Page,
} from "@hot-updater/plugin-core";

import type { BundleEventRow } from "./eventRow";
import type {
  InsightsBundleEventFilter,
  InsightsCountEventsInput,
  InsightsCountEventSeriesInput,
  InsightsCountLatestEventsInput,
  InsightsEventSeriesPoint,
  InsightsFindLatestEventsInput,
  InsightsGetAppUsageInput,
  InsightsGetAppUsageResult,
  InsightsGetReleaseActivityInput,
  InsightsGetReleaseActivityResult,
  InsightsListEventsInput,
  InsightsCoverage,
  InsightsTimeRange,
  ReleaseActivityMetrics,
  ReleaseReference,
} from "./modelTypes";
import { EVENT_LIST_RANGE_MS } from "./provider";
import {
  bundlePairKey,
  insightsIdentity,
  PAIR_FIELD,
  type InsightsIdentityParts,
} from "./recordEvent";
import {
  bundleRefOfFilter,
  DAILY_EVENTS,
  DAY_MS,
  HOUR_MS,
  type InsightsRetention,
  type InsightsSchema,
} from "./schema";

type Db = HotUpdaterDatabase<InsightsSchema>;
type Parts = Omit<InsightsIdentityParts, "periodKind">;
/** The lists that read one UTC day a query: global and bundle. */
type DayFilter = Exclude<
  InsightsListEventsInput["filter"],
  { readonly kind: "installationMovement" }
>;
/** Receipt bounds: from `since` to the cutoff, or to the cursor's row. */
interface EventRange {
  readonly gte: number;
  readonly lt: number | readonly [number, string];
}

const PAGE = 500;

const hourFloor = (ms: number) => ms - (ms % HOUR_MS);
const hourCeil = (ms: number) => hourFloor(ms + HOUR_MS - 1);
const dayFloor = (ms: number) => ms - (ms % DAY_MS);
const dayCeil = (ms: number) => dayFloor(ms + DAY_MS - 1);

/** Every page of one read, in order. */
const drain = async <T>(
  read: (page: { readonly cursor?: string }) => Promise<Page<T>>,
): Promise<T[]> => {
  const rows: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor === undefined ? {} : { cursor });
    rows.push(...page.rows);
    cursor = page.next;
  } while (cursor !== undefined);
  return rows;
};

const EVENT_FIELDS = [
  "id",
  "type",
  "install_id",
  "user_id",
  "from_release_id",
  "from_bundle_id",
  "to_release_id",
  "to_bundle_id",
  "platform",
  "app_version",
  "channel",
  "metadata",
  "received_at_ms",
] as const;

/** A stored event or head, as the event row it holds. */
const toEvent = (row: Readonly<Record<string, unknown>>): BundleEventRow =>
  Object.fromEntries(
    EVENT_FIELDS.map((field) => [field, row[field]]),
  ) as unknown as BundleEventRow;

const scopeOf = (filter: InsightsBundleEventFilter) => ({
  platform: filter.platform,
  channel: filter.channel,
  type: filter.type,
  bundle_ref: bundleRefOfFilter(filter),
});

/** One UTC day of a global or bundle list, newest first. */
const eventsOfDay = (
  db: Db,
  filter: DayFilter,
  day: number,
  range: EventRange,
  limit: number,
) =>
  filter.kind === "all"
    ? db.findMany("bundle_events", {
        index: "byDay",
        where: { day },
        range,
        order: "desc",
        limit,
      })
    : db.findMany("bundle_events", {
        index: "byBundle",
        where: { ...scopeOf(filter), day },
        range,
        order: "desc",
        limit,
      });

/**
 * The newest UTC day before `day`, and not before `since`'s, that holds an
 * event the list matches, from one outcome row: the global list's per-day
 * count, or the bundle filter's own hourly one.
 */
const newestDayBelow = async (
  db: Db,
  filter: DayFilter,
  day: number,
  since: number,
): Promise<number | undefined> => {
  const counted =
    filter.kind === "all"
      ? { where: DAILY_EVENTS, from: dayFloor(since) }
      : { where: scopeOf(filter), from: hourFloor(since) };
  const [newest] = (
    await db.findAggregates("insights_outcomes", {
      index: "byRef",
      where: counted.where,
      range: { gte: counted.from, lt: day },
      order: "desc",
      limit: 1,
    })
  ).rows;
  return newest === undefined ? undefined : dayFloor(newest.bucket_start_ms);
};

/**
 * Newest first over [since, before), after the cursor. The global and bundle
 * lists cover at most 90 × 24 hours, however many UTC days that touches, and
 * reject a longer range instead of cutting it short. They read one query per
 * UTC day that holds a matching event: a day that holds none is read once,
 * then one outcome row names the newest day below it that does, so a gap of
 * any length costs two reads.
 */
export const listEvents = async (
  db: Db,
  input: InsightsListEventsInput,
): Promise<readonly BundleEventRow[]> => {
  const since = input.sinceMs ?? 0;
  const range = {
    gte: since,
    lt:
      input.after === undefined
        ? input.beforeReceivedAtMs
        : ([input.after.receivedAtMs, input.after.id] as const),
  };
  const { filter, limit } = input;
  if (filter.kind === "installationMovement") {
    const page = await db.findMany("bundle_events", {
      index: "movementsByInstall",
      where: { movement_install_id: filter.installId },
      range,
      order: "desc",
      limit,
    });
    return page.rows.map(toEvent);
  }
  if (input.beforeReceivedAtMs - since > EVENT_LIST_RANGE_MS) {
    throw new DatabaseAdapterInputError("invalid-query");
  }
  const rows: BundleEventRow[] = [];
  const bottom = dayFloor(since);
  let day: number | undefined = dayFloor(
    input.after?.receivedAtMs ?? input.beforeReceivedAtMs - 1,
  );
  while (day !== undefined && day >= bottom && rows.length < limit) {
    const page = await eventsOfDay(db, filter, day, range, limit - rows.length);
    rows.push(...page.rows.map(toEvent));
    // A day with events may continue into the day before it; after an empty
    // day, the outcome counters name the next day to read, if any is left.
    day =
      page.rows.length > 0
        ? day - DAY_MS
        : day > bottom
          ? await newestDayBelow(db, filter, day, since)
          : undefined;
  }
  return rows;
};

/** One point read for an installation; a user's installations in binary install id order. */
export const findLatestEvents = async (
  db: Db,
  input: InsightsFindLatestEventsInput,
): Promise<readonly BundleEventRow[]> => {
  if ("installId" in input) {
    const head = await db.findOne("bundle_event_heads", {
      install_id: input.installId,
    });
    return head === null ? [] : [toEvent(head)];
  }
  const page = await db.findMany("bundle_event_heads", {
    index: "byUser",
    where: { user_id: input.userId },
    ...(input.afterInstallId === undefined
      ? {}
      : { range: { gt: input.afterInstallId } }),
    order: "asc",
    limit: input.limit,
  });
  return page.rows.map(toEvent);
};

/** Raw events of one bundle filter over [from, to), which spans at most two partial hours. */
const countRaw = async (
  db: Db,
  filter: InsightsBundleEventFilter,
  from: number,
  to: number,
) => {
  let total = 0;
  for (let day = dayFloor(from); from < to && day < to; day += DAY_MS) {
    const rows = await drain((page) =>
      db.findMany("bundle_events", {
        index: "byBundle",
        where: { ...scopeOf(filter), day },
        range: { gte: from, lt: to },
        limit: PAGE,
        ...page,
      }),
    );
    total += rows.length;
  }
  return total;
};

/**
 * Whole hours from outcome counters; the partial hours at either edge from
 * raw events. A download filter's whole hours count the downloads a launch
 * or crash implied too, which its raw events do not hold.
 */
export const countEvents = async (
  db: Db,
  input: InsightsCountEventsInput,
): Promise<number> => {
  const { filter, sinceMs, beforeReceivedAtMs } = input;
  const start = hourCeil(sinceMs);
  const end = hourFloor(beforeReceivedAtMs);
  if (start >= end) return countRaw(db, filter, sinceMs, beforeReceivedAtMs);
  const hours = await drain((page) =>
    db.findAggregates("insights_outcomes", {
      index: "byRef",
      where: scopeOf(filter),
      range: { gte: start, lt: end },
      limit: PAGE,
      ...page,
    }),
  );
  return (
    (await countRaw(db, filter, sinceMs, start)) +
    hours.reduce((sum, row) => sum + row.events, 0) +
    (await countRaw(db, filter, end, beforeReceivedAtMs))
  );
};

/**
 * A bundle filter's stored events in each interval of whole hours, and for a
 * download filter the downloads a launch or crash implied: one read of its
 * hourly counts, every interval present.
 */
export const countEventSeries = async (
  db: Db,
  input: InsightsCountEventSeriesInput,
): Promise<readonly InsightsEventSeriesPoint[]> => {
  const { filter, intervalMs } = input;
  const { start, end } = input.timeRange;
  const events = Array.from({ length: (end - start) / intervalMs }, () => 0);
  const hours = await drain((page) =>
    db.findAggregates("insights_outcomes", {
      index: "byRef",
      where: scopeOf(filter),
      range: { gte: start, lt: end },
      limit: PAGE,
      ...page,
    }),
  );
  for (const row of hours) {
    events[Math.floor((row.bucket_start_ms - start) / intervalMs)]! +=
      row.events;
  }
  return events.map((count, index) => ({
    startMs: start + index * intervalMs,
    events: count,
  }));
};

type Predicate = {
  readonly field: "from_bundle_id" | "to_bundle_id";
  readonly value: string;
  readonly type: string;
};

/** A bundle filter's distinct (field, value, type) predicates. */
const latestPredicates = (
  bundle: InsightsCountLatestEventsInput["bundle"],
): readonly Predicate[] | undefined => {
  if (bundle === undefined) return undefined;
  return [
    ...new Map(
      bundle.flatMap(({ field, value, types }) =>
        types.map((type) => [
          JSON.stringify([field, value, type]),
          { field, value, type },
        ]),
      ),
    ).values(),
  ];
};

/**
 * Latest events at or after `sinceMs`, a UTC day's start: the gauges count
 * each installation in the UTC day of its latest event, so they answer whole
 * days only, and a later start is rejected rather than rounded.
 */
export const countLatestEvents = async (
  db: Db,
  input: InsightsCountLatestEventsInput,
): Promise<number> => {
  const { platform, channel, sinceMs: start } = input;
  if (start % DAY_MS !== 0) {
    throw new DatabaseAdapterInputError("invalid-query");
  }
  const predicates = latestPredicates(input.bundle);
  let total = 0;
  if (predicates === undefined) {
    const rows = await drain((page) =>
      db.findAggregates("insights_distribution", {
        index: "byScope",
        where: { channel, platform },
        range: { gte: start },
        limit: PAGE,
        ...page,
      }),
    );
    total += rows.reduce((sum, row) => sum + row.latest_installations, 0);
  } else {
    const gauge = async (
      bundleField: string,
      bundleId: string,
      type: string,
    ) => {
      const rows = await drain((page) =>
        db.findAggregates("insights_latest_by_bundle", {
          index: "byBundle",
          where: {
            platform,
            channel,
            bundle_field: bundleField,
            bundle_id: bundleId,
            type,
          },
          range: { gte: start },
          limit: PAGE,
          ...page,
        }),
      );
      return rows.reduce((sum, row) => sum + row.installations, 0);
    };
    for (const { field, value, type } of predicates) {
      total += await gauge(field, value, type);
    }
    // A head has one (from, to) pair, so it matches a `from` and a `to`
    // predicate of one type only through that pair: subtract the pair's gauge
    // to count it once.
    for (const from of predicates) {
      if (from.field !== "from_bundle_id") continue;
      for (const to of predicates) {
        if (to.field !== "to_bundle_id" || to.type !== from.type) continue;
        total -= await gauge(
          PAIR_FIELD,
          bundlePairKey(from.value, to.value),
          from.type,
        );
      }
    }
  }
  // Batched gauges sum signed shard rows, which a lost change can leave
  // below zero: an installation count never is.
  return Math.max(0, total);
};

/** The oldest whole hour and UTC day that hourly and daily rows still hold. */
const retained = (now: number, { rawDays, dailyDays }: InsightsRetention) => ({
  hour: hourCeil(now - rawDays * DAY_MS),
  day: dayCeil(now - dailyDays * DAY_MS),
});

/**
 * Whether the rows a window reads still hold all of it; an older start is
 * partial from `oldest`, the first bucket its rows keep.
 */
const coverageOf = (start: number, oldest: number): InsightsCoverage =>
  start >= oldest
    ? { kind: "complete", sinceMs: 0 }
    : { kind: "partial", sinceMs: oldest };

/**
 * Periods covering [start, end): whole UTC days when `days` and the window is
 * over 48 hours, hours elsewhere. Hourly rows start at `hour`, the raw
 * period ago, so with `days` an edge older than that reads its whole UTC day
 * from the daily rows.
 */
const periodsOf = (range: InsightsTimeRange, days: boolean, hour: number) => {
  const start =
    days && range.start < hour ? dayFloor(range.start) : range.start;
  const end = days && range.end < hour ? dayCeil(range.end) : range.end;
  if (!days || (end - start <= 2 * DAY_MS && start >= hour)) {
    return [{ periodKind: "hour" as const, start, end }];
  }
  const first = Math.min(end, dayCeil(start));
  const last = Math.max(first, dayFloor(end));
  return [
    { periodKind: "hour" as const, start, end: first },
    { periodKind: "day" as const, start: first, end: last },
    { periodKind: "hour" as const, start: last, end },
  ].filter((period) => period.start < period.end);
};

interface CounterRow {
  readonly bucket_start_ms: number;
  readonly downloads: number;
  readonly failed_launches: number;
  readonly patch_downloads: number;
  readonly patch_fallbacks: number;
}

interface SketchRow {
  readonly bucket_start_ms: number;
  readonly activity_users: string | null;
  readonly failed_users: string | null;
}

/** The hourly and daily aggregates of counters, and of sketches. */
const COUNTERS = {
  hour: "insights_overview",
  day: "insights_overview_daily",
} as const;
const SKETCHES = {
  hour: "insights_sketches",
  day: "insights_sketches_daily",
} as const;

/** Every counter or sketch row of one identity over [start, end), mixing day and hour periods. */
const windowRows = async (
  db: Db,
  models: typeof COUNTERS | typeof SKETCHES,
  parts: Parts,
  range: InsightsTimeRange,
  days: boolean,
  hour: number,
): Promise<readonly object[]> => {
  const rows: object[] = [];
  for (const period of periodsOf(range, days, hour)) {
    const identity = insightsIdentity({
      ...parts,
      periodKind: period.periodKind,
    });
    rows.push(
      ...(await drain((page) =>
        db.findAggregates(models[period.periodKind], {
          index: "window",
          where: { identity },
          range: { gte: period.start, lt: period.end },
          limit: PAGE,
          ...page,
        }),
      )),
    );
  }
  return rows;
};

type WindowArgs = [Db, Parts, InsightsTimeRange, boolean, number];

const counterRows = (...[db, ...args]: WindowArgs) =>
  windowRows(db, COUNTERS, ...args) as Promise<readonly CounterRow[]>;

const sketchRows = (...[db, ...args]: WindowArgs) =>
  windowRows(db, SKETCHES, ...args) as Promise<readonly SketchRow[]>;

const releaseParts = (release: ReleaseReference): Parts => ({
  scopeKind: "release",
  releaseKind: "specific",
  releaseId: release.releaseId,
  channel: release.channel,
  platform: release.platform,
  appVersionKind: "all",
  appVersion: "",
});

/** A release's lifetime counters: one logical row at bucket 0. */
const lifetimeMetrics = async (
  db: Db,
  release: ReleaseReference,
): Promise<ReleaseActivityMetrics> => {
  const identity = insightsIdentity({
    ...releaseParts(release),
    periodKind: "lifetime",
  });
  const [lifetime] = (
    await db.findAggregates("insights_overview_lifetime", {
      index: "window",
      where: { identity },
      range: { gte: 0, lte: 0 },
      limit: PAGE,
    })
  ).rows;
  return {
    downloads: lifetime?.downloads ?? 0,
    applies: lifetime?.applies ?? 0,
    failedLaunches: lifetime?.failed_launches ?? 0,
  };
};

/** A channel and platform's usage rows, of every app version or of one. */
const usageParts = (
  channel: string,
  platform: "ios" | "android",
  appVersion?: string,
): Parts => ({
  scopeKind: "usage",
  releaseKind: "all",
  releaseId: "",
  channel,
  platform,
  appVersionKind: appVersion === undefined ? "all" : "specific",
  appVersion: appVersion ?? "",
});

/** Each release's lifetime counters, which are kept: one logical row apiece. */
export const getReleaseActivity = async (
  db: Db,
  input: InsightsGetReleaseActivityInput,
  now: () => number,
): Promise<InsightsGetReleaseActivityResult> => {
  const measuredAtMs = now();
  const data = await Promise.all(
    input.releases.map(async (release) => ({
      release,
      metrics: await lifetimeMetrics(db, release),
    })),
  );
  return { data, measuredAtMs };
};

/**
 * Entries with installations, most first. Batched gauges sum signed shard
 * rows, so a version or platform everyone left can read 0, and is left out.
 */
const byInstallations = (values: Map<string, number>) =>
  [...values]
    .flatMap(([name, installations]) =>
      installations > 0 ? [{ name, installations }] : [],
    )
    .sort(
      (left, right) =>
        right.installations - left.installations ||
        left.name.localeCompare(right.name, "en", { numeric: true }),
    );

export const getAppUsage = async (
  db: Db,
  input: InsightsGetAppUsageInput,
  now: () => number,
  retention: InsightsRetention,
): Promise<InsightsGetAppUsageResult> => {
  const { timeRange, intervalMs } = input;
  const at = now();
  const kept = retained(at, retention);
  const days = intervalMs % DAY_MS === 0 && timeRange.start % DAY_MS === 0;
  const reported =
    input.platform === "all" ? (["ios", "android"] as const) : [input.platform];
  // Every platform's usage is the ios and android sketches merged: each
  // installation reports one platform, so the union counts it once.
  const usage = (
    await Promise.all(
      reported.map((platform) =>
        sketchRows(
          db,
          usageParts(input.channel, platform, input.appVersion),
          timeRange,
          days,
          kept.hour,
        ),
      ),
    )
  ).flat();
  // Gauges count each installation in the UTC day of its latest event, so
  // the distribution covers every UTC day the window touches.
  const range = { gte: dayFloor(timeRange.start), lt: timeRange.end };
  const distribution = [];
  // Installations on their build's built-in bundle, which `distribution`
  // counts too, by the release they run and the bundle's ID.
  const builtinDistribution = [];
  for (const platform of reported) {
    distribution.push(
      ...(await drain((page) =>
        input.appVersion === undefined
          ? db.findAggregates("insights_distribution", {
              index: "byScope",
              where: { channel: input.channel, platform },
              range,
              limit: PAGE,
              ...page,
            })
          : db.findAggregates("insights_distribution", {
              index: "byVersion",
              where: {
                channel: input.channel,
                platform,
                app_version: input.appVersion,
              },
              range,
              limit: PAGE,
              ...page,
            }),
      )),
    );
    builtinDistribution.push(
      ...(await drain((page) =>
        input.appVersion === undefined
          ? db.findAggregates("insights_builtin_distribution", {
              index: "byScope",
              where: { channel: input.channel, platform },
              range,
              limit: PAGE,
              ...page,
            })
          : db.findAggregates("insights_builtin_distribution", {
              index: "byVersion",
              where: {
                channel: input.channel,
                platform,
                app_version: input.appVersion,
              },
              range,
              limit: PAGE,
              ...page,
            }),
      )),
    );
  }
  const points = [];
  for (
    let start = timeRange.start;
    start < timeRange.end;
    start += intervalMs
  ) {
    points.push({
      startMs: start,
      installations: countDistinct(
        mergeDistinct(
          usage
            .filter(
              (row) =>
                row.bucket_start_ms >= start &&
                row.bucket_start_ms < start + intervalMs,
            )
            .map((row) => row.activity_users),
        ),
      ),
    });
  }
  const versions = new Map<string, number>();
  const platforms = new Map<string, number>();
  const bundles = new Map<
    string,
    InsightsGetAppUsageResult["bundleDistribution"][number]
  >();
  const countBundle = (
    row: { readonly app_version: string; readonly platform: string },
    releaseId: string | null,
    builtinBundleId: string | null,
    count: number,
  ) => {
    const key = JSON.stringify([
      row.app_version,
      row.platform,
      releaseId,
      builtinBundleId,
    ]);
    bundles.set(key, {
      appVersion: row.app_version,
      platform: row.platform as "ios" | "android",
      releaseId,
      builtinBundleId,
      installations: (bundles.get(key)?.installations ?? 0) + count,
    });
  };
  for (const row of distribution) {
    const count = row.latest_installations;
    versions.set(row.app_version, (versions.get(row.app_version) ?? 0) + count);
    platforms.set(row.platform, (platforms.get(row.platform) ?? 0) + count);
    countBundle(row, row.release_id || null, null, count);
  }
  // They move from the row of their release, or of none, to their own.
  for (const row of builtinDistribution) {
    const releaseId = row.release_id || null;
    countBundle(row, releaseId, null, -row.latest_installations);
    countBundle(
      row,
      releaseId,
      row.builtin_bundle_id,
      row.latest_installations,
    );
  }
  const sortedVersions = byInstallations(versions);
  return {
    coverage: coverageOf(timeRange.start, kept[days ? "day" : "hour"]),
    activeInstallations: countDistinct(
      mergeDistinct(usage.map((row) => row.activity_users)),
    ),
    points,
    appVersions: sortedVersions.map(({ name }) => name),
    versions: sortedVersions,
    platforms: byInstallations(platforms),
    bundleDistribution: [...bundles.values()].filter(
      ({ installations }) => installations > 0,
    ),
    measuredAtMs: at,
  };
};

export interface InsightsUpdateFailuresInput {
  readonly platform: "ios" | "android";
  readonly channel: string;
  /** A release's failures; without it, the channel's, which need a time range. */
  readonly releaseId?: string;
  /** Without it, a release's failures since its first report. */
  readonly timeRange?: InsightsTimeRange;
}

/** Update failures of one stage and reason, and what else their clients knew. */
export interface InsightsFailureBreakdown {
  readonly stage: string;
  readonly reason: string;
  readonly events: number;
  /** By resource, HTTP status, origin code, and transport, most first. */
  readonly details: readonly {
    readonly resource: string | null;
    readonly httpStatus: number | null;
    readonly originCode: string | null;
    readonly transport: string | null;
    readonly events: number;
  }[];
}

export interface InsightsUpdateFailures {
  readonly coverage: InsightsCoverage;
  readonly measuredAtMs: number;
  /** Update failures other than failed checks: each client reports one at most once a UTC day. */
  readonly failedUpdates: number;
  /** Installations with such a failure, estimated. */
  readonly failedInstallations: number;
  /** Download reports: each installation reports a bundle's download once. */
  readonly downloads: number;
  /** Downloads a patch delivered, and those that fell back from a patch to files or the archive. */
  readonly patchDownloads: number;
  readonly patchFallbacks: number;
  /** A channel's failed update checks, installations with one, and its active installations, estimated. */
  readonly checks?: {
    readonly failures: number;
    readonly failedInstallations: number;
    readonly activeInstallations: number;
  };
  /** Over a time range: failures by stage and reason, most first. */
  readonly breakdown?: readonly InsightsFailureBreakdown[];
}

/** The longest period the failures read covers: the console's longest, 30 days. */
export const UPDATE_FAILURES_RANGE_MS = 30 * DAY_MS;

const isRange = (range: InsightsTimeRange | undefined) =>
  range === undefined ||
  (Number.isSafeInteger(range.start) &&
    Number.isSafeInteger(range.end) &&
    range.start >= 0 &&
    range.start < range.end &&
    range.end - range.start <= UPDATE_FAILURES_RANGE_MS);

const isText = (value: unknown, maxLength: number) =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength;

const failed = (...rows: readonly (readonly SketchRow[])[]) =>
  countDistinct(mergeDistinct(rows.flat().map((row) => row.failed_users)));

/** Entries of a count map, most first, then in key order. */
const mostFirst = <T>(counts: Map<string, { value: T; events: number }>) =>
  [...counts]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        right.events - left.events || compareUtf8(leftKey, rightKey),
    )
    .map(([, entry]) => entry);

/** The stages a failure row records: where an update failed. */
const FAILURE_STAGES = new Set(["check", "download", "install", "unknown"]);

/** Failure rows as their breakdown by stage, reason, and detail. */
const breakdownOf = (
  rows: readonly {
    readonly stage: string;
    readonly reason: string;
    readonly detail: string;
    readonly events: number;
  }[],
) => {
  const failures = new Map<
    string,
    {
      value: { stage: string; reason: string };
      events: number;
      details: Map<string, { value: string; events: number }>;
    }
  >();
  for (const { stage, reason, detail, events } of rows) {
    if (events <= 0) continue;
    const key = JSON.stringify([stage, reason]);
    const entry = failures.get(key) ?? {
      value: { stage, reason },
      events: 0,
      details: new Map(),
    };
    entry.events += events;
    const known = entry.details.get(detail) ?? { value: detail, events: 0 };
    known.events += events;
    entry.details.set(detail, known);
    failures.set(key, entry);
  }
  return mostFirst(failures).map(({ value, events }) => {
    const { details } = failures.get(
      JSON.stringify([value.stage, value.reason]),
    )!;
    return {
      ...value,
      events,
      details: mostFirst(details).map(({ value: detail, events }) => {
        const [resource, httpStatus, originCode, transport] = JSON.parse(
          detail,
        ) as [string | null, number | null, string | null, string | null];
        return { resource, httpStatus, originCode, transport, events };
      }),
    };
  });
};

/**
 * A release's or a channel's update failures. Since a release's first
 * report: its lifetime counters and failed installations. Over a time range
 * of at most 30 days: failures, failed checks, and the breakdown by stage,
 * reason, and detail, all summed from the breakdown's hourly rows; downloads
 * from the counters; failed installations from their sketches. A release reads hourly rows, a
 * channel daily rows past 48 hours like its activity; the breakdown's rows
 * are hourly, so its coverage is the raw period's.
 */
export const getUpdateFailures = async (
  db: Db,
  input: InsightsUpdateFailuresInput,
  now: () => number,
  retention: InsightsRetention,
): Promise<InsightsUpdateFailures> => {
  const { platform, channel, releaseId, timeRange } = input;
  if (
    (platform !== "ios" && platform !== "android") ||
    !isText(channel, 1_024) ||
    (releaseId !== undefined && !isText(releaseId, 36)) ||
    !isRange(timeRange) ||
    (releaseId === undefined && timeRange === undefined)
  ) {
    throw new DatabaseAdapterInputError("invalid-query");
  }
  const at = now();
  const kept = retained(at, retention);
  const channelParts: Parts = {
    ...usageParts(channel, platform),
    scopeKind: "channel",
  };
  const parts =
    releaseId === undefined
      ? channelParts
      : releaseParts({ releaseId, platform, channel });
  const failure: Parts = { ...parts, scopeKind: "failure" };
  if (timeRange === undefined) {
    const where = (from: Parts) => ({
      identity: insightsIdentity({ ...from, periodKind: "lifetime" }),
    });
    const [counters, sketches] = await Promise.all([
      db.findAggregates("insights_overview_lifetime", {
        index: "window",
        where: where(parts),
        range: { gte: 0, lte: 0 },
        limit: PAGE,
      }),
      db.findAggregates("insights_sketches_lifetime", {
        index: "window",
        where: where(failure),
        range: { gte: 0, lte: 0 },
        limit: PAGE,
      }),
    ]);
    const lifetime = counters.rows[0];
    return {
      coverage: { kind: "complete", sinceMs: 0 },
      measuredAtMs: at,
      failedUpdates: lifetime?.failed_updates ?? 0,
      failedInstallations: countDistinct(
        mergeDistinct(sketches.rows.map((row) => row.failed_users)),
      ),
      downloads: lifetime?.downloads ?? 0,
      patchDownloads: lifetime?.patch_downloads ?? 0,
      patchFallbacks: lifetime?.patch_fallbacks ?? 0,
    };
  }
  const days = releaseId === undefined;
  const window = [timeRange, days, kept.hour] as const;
  const [counters, failures, checks, active, rows] = await Promise.all([
    counterRows(db, parts, ...window),
    sketchRows(db, failure, ...window),
    days
      ? sketchRows(db, { ...channelParts, scopeKind: "check" }, ...window)
      : [],
    days ? sketchRows(db, usageParts(channel, platform), ...window) : [],
    drain((page) =>
      db.findAggregates("insights_failures", {
        index: "byScope",
        where: { platform, channel },
        range: { gte: timeRange.start, lt: timeRange.end },
        limit: PAGE,
        ...page,
      }),
    ),
  ]);
  const total = (field: Exclude<keyof CounterRow, "bucket_start_ms">) =>
    counters.reduce((sum, row) => sum + row[field], 0);
  // Only the stages a failure records count: other rows are no failure.
  const scoped = rows.filter(
    (row) =>
      FAILURE_STAGES.has(row.stage) &&
      (releaseId === undefined || row.release_id === releaseId),
  );
  // The breakdown's hourly rows hold every failure of the window, so its
  // counts are summed from them rather than kept twice.
  const failuresAt = (counted: (stage: string) => boolean) =>
    scoped.reduce(
      (sum, row) => sum + (counted(row.stage) ? Math.max(0, row.events) : 0),
      0,
    );
  return {
    coverage: coverageOf(timeRange.start, kept.hour),
    measuredAtMs: at,
    failedUpdates: failuresAt((stage) => stage !== "check"),
    failedInstallations: failed(failures),
    downloads: total("downloads"),
    patchDownloads: total("patch_downloads"),
    patchFallbacks: total("patch_fallbacks"),
    ...(days
      ? {
          checks: {
            failures: failuresAt((stage) => stage === "check"),
            failedInstallations: failed(checks),
            activeInstallations: countDistinct(
              mergeDistinct(active.map((row) => row.activity_users)),
            ),
          },
        }
      : {}),
    breakdown: breakdownOf(scoped),
  };
};
