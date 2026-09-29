import type {
  BundleEventRow,
  InsightsBundleEventFilter,
  InsightsCountEventsInput,
  InsightsCountLatestEventsInput,
  InsightsFindLatestEventsInput,
  InsightsGetAppUsageInput,
  InsightsGetAppUsageResult,
  InsightsGetReleaseActivityInput,
  InsightsGetReleaseActivityResult,
  InsightsListEventsInput,
  InsightsTimeRange,
  ReleaseActivityMetrics,
  ReleaseReference,
} from "@hot-updater/plugin-core";
import {
  countInsightsDistinct,
  mergeInsightsDistinct,
} from "@hot-updater/plugin-core/internal";

import type { HotUpdaterDatabase } from "../../database/database";
import type { Page } from "../../database/engineReads";
import { insightsIdentity, type InsightsIdentityParts } from "./recordEvent";
import { DAY_MS, HOUR_MS, type InsightsSchema } from "./schema";

type Db = HotUpdaterDatabase<InsightsSchema>;
type Parts = Omit<InsightsIdentityParts, "periodKind">;

const PAGE = 500;
/** How far back a day-partitioned list reads. */
const LIST_DAYS = 90;

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

/** Newest first over [since, before), after the cursor; day-partitioned lists read at most 90 days. */
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
  const rows: BundleEventRow[] = [];
  const top = dayFloor(
    input.after?.receivedAtMs ?? input.beforeReceivedAtMs - 1,
  );
  const bottom = Math.max(dayFloor(since), top - (LIST_DAYS - 1) * DAY_MS);
  for (let day = top; day >= bottom && rows.length < limit; day -= DAY_MS) {
    const rest = limit - rows.length;
    const page =
      filter.kind === "all"
        ? await db.findMany("bundle_events", {
            index: "byDay",
            where: { day },
            range,
            order: "desc",
            limit: rest,
          })
        : await db.findMany("bundle_events", {
            index: "byBundle",
            where: { ...scopeOf(filter), day },
            range,
            order: "desc",
            limit: rest,
          });
    rows.push(...page.rows.map(toEvent));
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

/** Heads whose latest event falls in [sinceMs, end), a partial hour: those events' installs, then their heads. */
const countPartialHeads = async (
  db: Db,
  input: InsightsCountLatestEventsInput,
  predicates: readonly Predicate[] | undefined,
  end: number,
) => {
  const events = await drain((page) =>
    db.findMany("bundle_events", {
      index: "recent",
      where: {
        channel: input.channel,
        platform: input.platform,
        day: dayFloor(input.sinceMs),
      },
      range: { gte: input.sinceMs, lt: end },
      limit: PAGE,
      ...page,
    }),
  );
  const ids = new Set(events.map(({ id }) => id));
  const heads = await Promise.all(
    [...new Set(events.map(({ install_id }) => install_id))].map((install) =>
      db.findOne("bundle_event_heads", { install_id: install }),
    ),
  );
  return heads.filter(
    (head) =>
      head !== null &&
      ids.has(head.id) &&
      (predicates === undefined ||
        predicates.some(
          ({ field, value, type }) =>
            head[field] === value && head.type === type,
        )),
  ).length;
};

/** Latest events at or after `sinceMs`: whole hours from gauges, the first partial hour from heads. */
export const countLatestEvents = async (
  db: Db,
  input: InsightsCountLatestEventsInput,
): Promise<number> => {
  const { platform, channel, sinceMs } = input;
  const start = hourCeil(sinceMs);
  const predicates =
    input.bundle === undefined
      ? undefined
      : [
          ...new Map(
            input.bundle.flatMap(({ field, value, types }) =>
              types.map((type) => [
                JSON.stringify([field, value, type]),
                { field, value, type },
              ]),
            ),
          ).values(),
        ];
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
    for (const { field, value, type } of predicates) {
      const rows = await drain((page) =>
        db.findAggregates("insights_latest_by_bundle", {
          index: "byBundle",
          where: {
            platform,
            channel,
            bundle_field: field,
            bundle_id: value,
            type,
          },
          range: { gte: start },
          limit: PAGE,
          ...page,
        }),
      );
      total += rows.reduce((sum, row) => sum + row.installations, 0);
    }
  }
  return sinceMs < start
    ? total + (await countPartialHeads(db, input, predicates, start))
    : total;
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

/** Counters, unique users, and a per-UTC-day series over a window. */
const rangedMetrics = async (
  db: Db,
  parts: Parts,
  range: InsightsTimeRange,
  days: boolean,
): Promise<ReleaseActivityMetrics> => {
  const [counters, sketches] = await Promise.all([
    counterRows(db, parts, range, days),
    sketchRows(db, parts, range, days),
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
      mergeInsightsDistinct(sketches.map((row) => row.launch_users)),
    ),
    series: [...series]
      .sort(([left], [right]) => left - right)
      .map(([startMs, point]) => ({ startMs, ...point })),
  };
};

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

const byInstallations = (values: Map<string, number>) =>
  [...values]
    .map(([name, installations]) => ({ name, installations }))
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
  const usage = await sketchRows(
    db,
    {
      scopeKind: "usage",
      releaseKind: "all",
      releaseId: "",
      channel: input.channel,
      platform: input.platform,
      appVersionKind: input.appVersion === undefined ? "all" : "specific",
      appVersion: input.appVersion ?? "",
    },
    timeRange,
    intervalMs % DAY_MS === 0 && timeRange.start % DAY_MS === 0,
  );
  const distribution = [];
  for (const platform of input.platform === "all"
    ? (["ios", "android"] as const)
    : [input.platform]) {
    distribution.push(
      ...(await drain((page) =>
        input.appVersion === undefined
          ? db.findAggregates("insights_distribution", {
              index: "byScope",
              where: { channel: input.channel, platform },
              range: { gte: timeRange.start, lt: timeRange.end },
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
              range: { gte: timeRange.start, lt: timeRange.end },
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
    bundleDistribution: [...bundles.values()],
    measuredAtMs: now(),
  };
};
