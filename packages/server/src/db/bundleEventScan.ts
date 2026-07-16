import type { BundleEventRow, DatabaseWhere } from "@hot-updater/plugin-core";

import type { BundleEventAnalyticsWindow, DatabaseAdapter } from "./types";

export const BUNDLE_EVENT_SCAN_PAGE_SIZE = 100;

type ScanOrderField = {
  readonly [TField in keyof BundleEventRow]: BundleEventRow[TField] extends
    | string
    | number
    ? TField
    : never;
}[keyof BundleEventRow];

type ScanOrderBy = readonly [
  {
    readonly field: ScanOrderField;
    readonly direction: "asc" | "desc";
  },
  ...{
    readonly field: ScanOrderField;
    readonly direction: "asc" | "desc";
  }[],
];

type ScanInput = {
  readonly where?: readonly DatabaseWhere<"bundle_events">[];
  readonly orderBy: ScanOrderBy;
};

export const newestEventOrder = [
  { field: "received_at_ms", direction: "desc" },
  { field: "id", direction: "desc" },
] as const;

export const latestInstallOrder = [
  { field: "install_id", direction: "asc" },
  ...newestEventOrder,
] as const;

const earliestInstallOrder = [
  { field: "install_id", direction: "asc" },
  { field: "received_at_ms", direction: "asc" },
  { field: "id", direction: "asc" },
] as const;

const cohortInstallOrder = [
  { field: "cohort", direction: "asc" },
  { field: "install_id", direction: "asc" },
  { field: "received_at_ms", direction: "asc" },
  { field: "id", direction: "asc" },
] as const;

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareScanValues = (
  left: string | number,
  right: string | number,
): number => {
  if (typeof left === "number") {
    return typeof right === "number" ? left - right : -1;
  }
  return typeof right === "string" ? compareCodePoints(left, right) : 1;
};

const compareScanRows = (
  left: BundleEventRow,
  right: BundleEventRow,
  orderBy: ScanOrderBy,
): number => {
  for (const clause of orderBy) {
    const order = compareScanValues(left[clause.field], right[clause.field]);
    if (order !== 0) {
      return clause.direction === "asc" ? order : -order;
    }
  }
  return 0;
};

export async function* scanBundleEventRows<TContext>(
  database: DatabaseAdapter<TContext>,
  input: ScanInput,
  context?: TContext,
): AsyncGenerator<BundleEventRow> {
  let offset = 0;
  let lastYielded: BundleEventRow | undefined;
  while (true) {
    const rows = await database.findMany(
      {
        model: "bundle_events",
        where: input.where,
        orderBy: input.orderBy,
        limit: BUNDLE_EVENT_SCAN_PAGE_SIZE,
        offset,
      },
      context,
    );
    for (const row of rows) {
      if (
        lastYielded !== undefined &&
        compareScanRows(row, lastYielded, input.orderBy) <= 0
      ) {
        continue;
      }
      lastYielded = row;
      yield row;
    }
    offset += rows.length;
    if (rows.length < BUNDLE_EVENT_SCAN_PAGE_SIZE) return;
  }
}

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

const finiteRange = (
  window: Exclude<BundleEventAnalyticsWindow, "all">,
  now: number,
): { readonly sizeMs: number; readonly rangeStart: number } => {
  if (window === "24h") {
    return {
      sizeMs: 60 * 60 * 1000,
      rangeStart: startOfUtcHour(now) - 23 * 60 * 60 * 1000,
    };
  }
  const days = window === "7d" ? 7 : 30;
  return {
    sizeMs: 24 * 60 * 60 * 1000,
    rangeStart: startOfUtcDay(now) - (days - 1) * 24 * 60 * 60 * 1000,
  };
};

const bucketStart = (receivedAtMs: number, sizeMs: number): number =>
  sizeMs === 60 * 60 * 1000
    ? startOfUtcHour(receivedAtMs)
    : startOfUtcDay(receivedAtMs);

export const scanDistinctInstallations = async <TContext>(
  database: DatabaseAdapter<TContext>,
  where: readonly DatabaseWhere<"bundle_events">[],
  context?: TContext,
): Promise<number> => {
  let previousInstallId: string | undefined;
  let total = 0;
  for await (const row of scanBundleEventRows(
    database,
    { where, orderBy: earliestInstallOrder },
    context,
  )) {
    if (row.install_id === previousInstallId) continue;
    previousInstallId = row.install_id;
    total += 1;
  }
  return total;
};

const scanCohorts = async <TContext>(
  database: DatabaseAdapter<TContext>,
  where: readonly DatabaseWhere<"bundle_events">[],
  context?: TContext,
): Promise<{ readonly cohort: string; readonly value: number }[]> => {
  const counts = new Map<string, number>();
  let previousCohort: string | undefined;
  let previousInstallId: string | undefined;
  for await (const row of scanBundleEventRows(
    database,
    { where, orderBy: cohortInstallOrder },
    context,
  )) {
    if (row.cohort === previousCohort && row.install_id === previousInstallId) {
      continue;
    }
    previousCohort = row.cohort;
    previousInstallId = row.install_id;
    counts.set(row.cohort, (counts.get(row.cohort) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([cohort, value]) => ({ cohort, value }));
};

const scanSeries = async <TContext>(
  database: DatabaseAdapter<TContext>,
  where: readonly DatabaseWhere<"bundle_events">[],
  window: BundleEventAnalyticsWindow,
  now: number,
  context?: TContext,
): Promise<{ readonly bucketStartMs: number; readonly value: number }[]> => {
  const range = window === "all" ? undefined : finiteRange(window, now);
  const seriesWhere: readonly DatabaseWhere<"bundle_events">[] = range
    ? [
        ...where,
        {
          field: "received_at_ms",
          operator: "gte",
          value: range.rangeStart,
        },
      ]
    : where;
  const counts = new Map<number, number>();
  let previousInstallId: string | undefined;
  let oldestMatchingMs: number | undefined;
  const collect = (row: BundleEventRow): void => {
    if (range && row.received_at_ms < range.rangeStart) return;
    oldestMatchingMs = Math.min(
      oldestMatchingMs ?? row.received_at_ms,
      row.received_at_ms,
    );
    if (row.install_id === previousInstallId) return;
    previousInstallId = row.install_id;
    const sizeMs = range?.sizeMs ?? 24 * 60 * 60 * 1000;
    const start = bucketStart(row.received_at_ms, sizeMs);
    if (start <= bucketStart(now, sizeMs)) {
      counts.set(start, (counts.get(start) ?? 0) + 1);
    }
  };
  for await (const row of scanBundleEventRows(
    database,
    {
      where: seriesWhere,
      orderBy: earliestInstallOrder,
    },
    context,
  )) {
    collect(row);
  }
  const sizeMs = range?.sizeMs ?? 24 * 60 * 60 * 1000;
  const first = range?.rangeStart ?? startOfUtcDay(oldestMatchingMs ?? now);
  const last = bucketStart(now, sizeMs);
  let cumulative = 0;
  const series: { bucketStartMs: number; value: number }[] = [];
  for (let start = first; start <= last; start += sizeMs) {
    cumulative += counts.get(start) ?? 0;
    series.push({ bucketStartMs: start, value: cumulative });
  }
  return series;
};

export const scanBundleEventActivity = async <TContext>(
  database: DatabaseAdapter<TContext>,
  where: readonly DatabaseWhere<"bundle_events">[],
  window: BundleEventAnalyticsWindow,
  now: number,
  context?: TContext,
) => {
  const [summary, cohorts, series] = await Promise.all([
    scanDistinctInstallations(database, where, context),
    scanCohorts(database, where, context),
    scanSeries(database, where, window, now, context),
  ]);
  return { summary, cohorts, series };
};

const compareNewest = (left: BundleEventRow, right: BundleEventRow): number =>
  right.received_at_ms - left.received_at_ms ||
  (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);

export const scanRecentBundleEvents = async <TContext>(
  database: DatabaseAdapter<TContext>,
  installedWhere: readonly DatabaseWhere<"bundle_events">[],
  recoveredWhere: readonly DatabaseWhere<"bundle_events">[],
  limit: number,
  offset: number,
  context?: TContext,
) => {
  const installed = scanBundleEventRows(
    database,
    { where: installedWhere, orderBy: newestEventOrder },
    context,
  )[Symbol.asyncIterator]();
  const recovered = scanBundleEventRows(
    database,
    { where: recoveredWhere, orderBy: newestEventOrder },
    context,
  )[Symbol.asyncIterator]();
  let installedNext = await installed.next();
  let recoveredNext = await recovered.next();
  let total = 0;
  const rows: BundleEventRow[] = [];
  while (!installedNext.done || !recoveredNext.done) {
    const takeInstalled =
      recoveredNext.done ||
      (!installedNext.done &&
        compareNewest(installedNext.value, recoveredNext.value) <= 0);
    const row = takeInstalled ? installedNext.value : recoveredNext.value;
    if (total >= offset && rows.length < limit) rows.push(row);
    total += 1;
    if (takeInstalled) installedNext = await installed.next();
    else recoveredNext = await recovered.next();
  }
  return { rows, total };
};
