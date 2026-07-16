import type {
  BundleEventRow,
  DatabaseOrderBy,
  DatabaseWhere,
} from "@hot-updater/plugin-core";

import type { BundleEventAnalyticsWindow, DatabaseAdapter } from "./types";

export const BUNDLE_EVENT_SCAN_PAGE_SIZE = 100;
export const BUNDLE_EVENT_SCAN_MAX_ROWS = 50_000;
export const BUNDLE_EVENT_SCAN_MAX_PAGES =
  BUNDLE_EVENT_SCAN_MAX_ROWS / BUNDLE_EVENT_SCAN_PAGE_SIZE + 1;

export class BundleEventScanLimitExceededError extends Error {
  readonly name = "BundleEventScanLimitExceededError";

  constructor(readonly limit: number) {
    super(`Bundle event scan exceeded ${limit} rows.`);
  }
}

export type BundleEventScanScope<TContext> = {
  readonly database: DatabaseAdapter<TContext>;
  readonly cutoffMs: number;
  readonly context?: TContext;
};

type BundleEventScanRequest = {
  readonly where?: readonly DatabaseWhere<"bundle_events">[];
  readonly orderBy: DatabaseOrderBy<"bundle_events">;
};

type DistinctInstallationsRequest = {
  readonly where: readonly DatabaseWhere<"bundle_events">[];
};

type BundleEventActivityRequest = DistinctInstallationsRequest & {
  readonly window: BundleEventAnalyticsWindow;
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

export const withBundleEventCutoff = (
  where: readonly DatabaseWhere<"bundle_events">[] | undefined,
  cutoffMs: number,
): readonly DatabaseWhere<"bundle_events">[] => [
  ...(where ?? []),
  {
    field: "received_at_ms",
    operator: "lt",
    value: cutoffMs,
  },
];

export async function* scanBundleEventRows<TContext>(
  scope: BundleEventScanScope<TContext>,
  request: BundleEventScanRequest,
): AsyncGenerator<BundleEventRow> {
  let offset = 0;
  let yielded = 0;
  const where = withBundleEventCutoff(request.where, scope.cutoffMs);
  for (let page = 0; page < BUNDLE_EVENT_SCAN_MAX_PAGES; page += 1) {
    const rows = await scope.database.findMany(
      {
        model: "bundle_events",
        where,
        orderBy: request.orderBy,
        limit: BUNDLE_EVENT_SCAN_PAGE_SIZE,
        offset,
      },
      scope.context,
    );
    for (const row of rows) {
      if (yielded === BUNDLE_EVENT_SCAN_MAX_ROWS) {
        throw new BundleEventScanLimitExceededError(BUNDLE_EVENT_SCAN_MAX_ROWS);
      }
      yielded += 1;
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
  scope: BundleEventScanScope<TContext>,
  request: DistinctInstallationsRequest,
): Promise<number> => {
  let previousInstallId: string | undefined;
  let total = 0;
  for await (const row of scanBundleEventRows(scope, {
    where: request.where,
    orderBy: earliestInstallOrder,
  })) {
    if (row.install_id === previousInstallId) continue;
    previousInstallId = row.install_id;
    total += 1;
  }
  return total;
};

const scanCohorts = async <TContext>(
  scope: BundleEventScanScope<TContext>,
  request: DistinctInstallationsRequest,
): Promise<{ readonly cohort: string; readonly value: number }[]> => {
  const counts = new Map<string, number>();
  let previousCohort: string | undefined;
  let previousInstallId: string | undefined;
  for await (const row of scanBundleEventRows(scope, {
    where: request.where,
    orderBy: cohortInstallOrder,
  })) {
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
  scope: BundleEventScanScope<TContext>,
  request: BundleEventActivityRequest,
): Promise<{ readonly bucketStartMs: number; readonly value: number }[]> => {
  const range =
    request.window === "all"
      ? undefined
      : finiteRange(request.window, scope.cutoffMs);
  const seriesWhere: readonly DatabaseWhere<"bundle_events">[] = range
    ? [
        ...request.where,
        {
          field: "received_at_ms",
          operator: "gte",
          value: range.rangeStart,
        },
      ]
    : request.where;
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
    if (start <= bucketStart(scope.cutoffMs, sizeMs)) {
      counts.set(start, (counts.get(start) ?? 0) + 1);
    }
  };
  for await (const row of scanBundleEventRows(scope, {
    where: seriesWhere,
    orderBy: earliestInstallOrder,
  })) {
    collect(row);
  }
  const sizeMs = range?.sizeMs ?? 24 * 60 * 60 * 1000;
  const first =
    range?.rangeStart ?? startOfUtcDay(oldestMatchingMs ?? scope.cutoffMs);
  const last = bucketStart(scope.cutoffMs, sizeMs);
  let cumulative = 0;
  const series: { bucketStartMs: number; value: number }[] = [];
  for (let start = first; start <= last; start += sizeMs) {
    cumulative += counts.get(start) ?? 0;
    series.push({ bucketStartMs: start, value: cumulative });
  }
  return series;
};

export const scanBundleEventActivity = async <TContext>(
  scope: BundleEventScanScope<TContext>,
  request: BundleEventActivityRequest,
) => {
  const [summary, cohorts, series] = await Promise.all([
    scanDistinctInstallations(scope, request),
    scanCohorts(scope, request),
    scanSeries(scope, request),
  ]);
  return { summary, cohorts, series };
};
