import {
  DatabasePluginInputError,
  type BundleEventRow,
  type InsightsBundleEventFilter,
  type InsightsCountEventsInput,
  type InsightsCountLatestEventsInput,
  type InsightsFindLatestEventsInput,
  type InsightsGetAppUsageInput,
  type InsightsGetAppUsageResult,
  type InsightsGetReleaseActivityInput,
  type InsightsGetReleaseActivityResult,
  type InsightsListEventsInput,
  type InsightsTimeRange,
  type ReleaseActivityMetrics,
  type ReleaseReference,
} from "@hot-updater/plugin-core";
import {
  countInsightsDistinct,
  mergeInsightsDistinct,
} from "@hot-updater/plugin-core/internal";

import type { HotUpdaterDatabase } from "../../database/database";
import type { Page } from "../../database/engineReads";
import { EVENT_LIST_RANGE_MS } from "../../insights/provider";
import {
  bundlePairKey,
  insightsIdentity,
  PAIR_FIELD,
  type InsightsIdentityParts,
} from "./recordEvent";
import { DAILY_EVENTS, DAY_MS, HOUR_MS, type InsightsSchema } from "./schema";

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

const bundleRef = (filter: InsightsBundleEventFilter) =>
  filter.type === "RECOVERED"
    ? `from:${filter.fromBundleId}`
    : `to:${filter.toBundleId}`;

const scopeOf = (filter: InsightsBundleEventFilter) => ({
  platform: filter.platform,
  channel: filter.channel,
  type: filter.type,
  bundle_ref: bundleRef(filter),
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
    throw new DatabasePluginInputError("invalid-query");
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

/** Whole hours from outcome counters; the partial hours at either edge from raw events. */
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
    throw new DatabasePluginInputError("invalid-query");
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

/** Periods covering [start, end): whole UTC days when `days` and the window is over 48 hours, hours elsewhere. */
const periodsOf = (range: InsightsTimeRange, days: boolean) => {
  const { start, end } = range;
  if (!days || end - start <= 2 * DAY_MS) {
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
  readonly launches: number;
  readonly failed_launches: number;
}

interface SketchRow {
  readonly bucket_start_ms: number;
  readonly launch_users: string | null;
  readonly activity_users: string | null;
}

/** Every overview or sketch row of one identity over [start, end), mixing day and hour periods. */
const windowRows = async (
  db: Db,
  model: "insights_overview" | "insights_sketches",
  parts: Parts,
  range: InsightsTimeRange,
  days: boolean,
): Promise<readonly object[]> => {
  const rows: object[] = [];
  for (const period of periodsOf(range, days)) {
    const identity = insightsIdentity({
      ...parts,
      periodKind: period.periodKind,
    });
    rows.push(
      ...(await drain((page) =>
        db.findAggregates(model, {
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

const counterRows = (...args: [Db, Parts, InsightsTimeRange, boolean]) =>
  windowRows(
    args[0],
    "insights_overview",
    args[1],
    args[2],
    args[3],
  ) as Promise<readonly CounterRow[]>;

const sketchRows = (...args: [Db, Parts, InsightsTimeRange, boolean]) =>
  windowRows(
    args[0],
    "insights_sketches",
    args[1],
    args[2],
    args[3],
  ) as Promise<readonly SketchRow[]>;

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
    await db.findAggregates("insights_overview", {
      index: "window",
      where: { identity },
      range: { gte: 0, lte: 0 },
      limit: PAGE,
    })
  ).rows;
  return {
    downloads: lifetime?.downloads ?? 0,
    launches: lifetime?.launches ?? 0,
    failedLaunches: lifetime?.failed_launches ?? 0,
  };
};

/** Where unique users come from: the sketch rows of one identity, and their field. */
interface UserSketches {
  readonly parts: Parts;
  readonly field: "launch_users" | "activity_users";
}

/** Counters, unique users, and a per-UTC-day series over a window. */
const rangedMetrics = async (
  db: Db,
  parts: Parts,
  users: UserSketches,
  range: InsightsTimeRange,
  days: boolean,
): Promise<ReleaseActivityMetrics> => {
  const [counters, sketches] = await Promise.all([
    counterRows(db, parts, range, days),
    sketchRows(db, users.parts, range, days),
  ]);
  const series = new Map<
    number,
    { launches: number; failedLaunches: number }
  >();
  for (const row of counters) {
    const day = dayFloor(row.bucket_start_ms);
    const point = series.get(day) ?? { launches: 0, failedLaunches: 0 };
    point.launches += row.launches;
    point.failedLaunches += row.failed_launches;
    series.set(day, point);
  }
  const total = (field: "downloads" | "launches" | "failed_launches") =>
    counters.reduce((sum, row) => sum + row[field], 0);
  return {
    downloads: total("downloads"),
    launches: total("launches"),
    failedLaunches: total("failed_launches"),
    uniqueUsers: countInsightsDistinct(
      mergeInsightsDistinct(sketches.map((row) => row[users.field])),
    ),
    series: [...series]
      .sort(([left], [right]) => left - right)
      .map(([startMs, point]) => ({ startMs, ...point })),
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

export const getReleaseActivity = async (
  db: Db,
  input: InsightsGetReleaseActivityInput,
  now: () => number,
): Promise<InsightsGetReleaseActivityResult> => {
  const data =
    input.scope !== undefined
      ? [
          {
            scope: input.scope,
            // A channel's unique users are its active installations: its
            // usage rows count every installation that reported.
            metrics: await rangedMetrics(
              db,
              {
                scopeKind: "channel",
                releaseKind: "all",
                releaseId: "",
                channel: input.scope.channel,
                platform: input.scope.platform,
                appVersionKind: "all",
                appVersion: "",
              },
              {
                parts: usageParts(input.scope.channel, input.scope.platform),
                field: "activity_users",
              },
              input.timeRange,
              true,
            ),
          },
        ]
      : await Promise.all(
          input.releases.map(async (release) => ({
            release,
            metrics:
              input.timeRange === undefined
                ? await lifetimeMetrics(db, release)
                : await rangedMetrics(
                    db,
                    releaseParts(release),
                    { parts: releaseParts(release), field: "launch_users" },
                    input.timeRange,
                    false,
                  ),
          })),
        );
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    data,
    measuredAtMs: now(),
  };
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
): Promise<InsightsGetAppUsageResult> => {
  const { timeRange, intervalMs } = input;
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
          intervalMs % DAY_MS === 0 && timeRange.start % DAY_MS === 0,
        ),
      ),
    )
  ).flat();
  // Gauges count each installation in the UTC day of its latest event, so
  // the distribution covers every UTC day the window touches.
  const range = { gte: dayFloor(timeRange.start), lt: timeRange.end };
  const distribution = [];
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
  }
  const points = [];
  for (
    let start = timeRange.start;
    start < timeRange.end;
    start += intervalMs
  ) {
    points.push({
      startMs: start,
      installations: countInsightsDistinct(
        mergeInsightsDistinct(
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
  for (const row of distribution) {
    const count = row.latest_installations;
    versions.set(row.app_version, (versions.get(row.app_version) ?? 0) + count);
    platforms.set(row.platform, (platforms.get(row.platform) ?? 0) + count);
    const releaseId = row.release_id === "" ? null : row.release_id;
    const key = JSON.stringify([row.app_version, row.platform, releaseId]);
    bundles.set(key, {
      appVersion: row.app_version,
      platform: row.platform as "ios" | "android",
      releaseId,
      installations: (bundles.get(key)?.installations ?? 0) + count,
    });
  }
  const sortedVersions = byInstallations(versions);
  return {
    coverage: { kind: "complete", sinceMs: 0 },
    activeInstallations: countInsightsDistinct(
      mergeInsightsDistinct(usage.map((row) => row.activity_users)),
    ),
    points,
    appVersions: sortedVersions.map(({ name }) => name),
    versions: sortedVersions,
    platforms: byInstallations(platforms),
    bundleDistribution: [...bundles.values()].filter(
      ({ installations }) => installations > 0,
    ),
    measuredAtMs: now(),
  };
};
