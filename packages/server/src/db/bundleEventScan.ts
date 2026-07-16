import type { BundleEventRow, DatabaseWhere } from "@hot-updater/plugin-core";

import type { BundleEventAnalyticsWindow, DatabaseAdapter } from "./types";

export const BUNDLE_EVENT_SCAN_MAX_ROWS = 50_000;
export const BUNDLE_EVENT_MATERIALIZATION_LIMIT =
  BUNDLE_EVENT_SCAN_MAX_ROWS + 1;

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

type BundleEventActivityRequest = {
  readonly rows: readonly BundleEventRow[];
  readonly window: BundleEventAnalyticsWindow;
  readonly cutoffMs: number;
};

export const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const compareBundleEventNewest = (
  left: BundleEventRow,
  right: BundleEventRow,
): number =>
  right.received_at_ms - left.received_at_ms ||
  compareCodePoints(right.id, left.id);

export const withBundleEventCutoff = (
  where: readonly DatabaseWhere<"bundle_events">[] | undefined,
  cutoffMs: number,
): readonly DatabaseWhere<"bundle_events">[] => [
  ...(where ?? []),
  { field: "received_at_ms", operator: "lt", value: cutoffMs },
];

export const materializeBundleEventRows = async <TContext>(
  scope: BundleEventScanScope<TContext>,
  where?: readonly DatabaseWhere<"bundle_events">[],
): Promise<readonly BundleEventRow[]> => {
  const rows = await scope.database.findMany(
    {
      model: "bundle_events",
      where: withBundleEventCutoff(where, scope.cutoffMs),
      limit: BUNDLE_EVENT_MATERIALIZATION_LIMIT,
      offset: 0,
    },
    scope.context,
  );
  if (rows.length > BUNDLE_EVENT_SCAN_MAX_ROWS) {
    throw new BundleEventScanLimitExceededError(BUNDLE_EVENT_SCAN_MAX_ROWS);
  }
  return rows;
};

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

const createSeries = (
  request: BundleEventActivityRequest,
): { readonly bucketStartMs: number; readonly value: number }[] => {
  const range =
    request.window === "all"
      ? undefined
      : finiteRange(request.window, request.cutoffMs);
  const firstByInstall = new Map<string, BundleEventRow>();
  for (const row of request.rows) {
    if (range && row.received_at_ms < range.rangeStart) continue;
    const current = firstByInstall.get(row.install_id);
    if (
      !current ||
      row.received_at_ms < current.received_at_ms ||
      (row.received_at_ms === current.received_at_ms && row.id < current.id)
    ) {
      firstByInstall.set(row.install_id, row);
    }
  }
  const sizeMs = range?.sizeMs ?? 24 * 60 * 60 * 1000;
  const counts = new Map<number, number>();
  let oldestMs = request.cutoffMs;
  for (const row of firstByInstall.values()) {
    oldestMs = Math.min(oldestMs, row.received_at_ms);
    const start = bucketStart(row.received_at_ms, sizeMs);
    counts.set(start, (counts.get(start) ?? 0) + 1);
  }
  const first = range?.rangeStart ?? startOfUtcDay(oldestMs);
  const last = bucketStart(request.cutoffMs, sizeMs);
  let cumulative = 0;
  const series: { bucketStartMs: number; value: number }[] = [];
  for (let start = first; start <= last; start += sizeMs) {
    cumulative += counts.get(start) ?? 0;
    series.push({ bucketStartMs: start, value: cumulative });
  }
  return series;
};

export const collectBundleEventActivity = (
  request: BundleEventActivityRequest,
) => {
  const installs = new Set<string>();
  const installsByCohort = new Map<string, Set<string>>();
  for (const row of request.rows) {
    installs.add(row.install_id);
    const cohort = installsByCohort.get(row.cohort) ?? new Set<string>();
    cohort.add(row.install_id);
    installsByCohort.set(row.cohort, cohort);
  }
  return {
    summary: installs.size,
    cohorts: [...installsByCohort]
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([cohort, installIds]) => ({ cohort, value: installIds.size })),
    series: createSeries(request),
  };
};
