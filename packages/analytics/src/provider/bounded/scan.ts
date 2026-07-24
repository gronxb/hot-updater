import type {
  DatabaseCapabilityRuntime,
  DatabaseRow,
  DatabaseWhere,
} from "@hot-updater/plugin-core";

import type {
  ActiveInstallationWindow,
  BundleEventAnalyticsWindow,
} from "../../domain";
import { AnalyticsScanLimitExceededError } from "../../errors";
import {
  ACTIVE_BUNDLE_EVENT_TYPES,
  getActiveWindowDefinition,
} from "./activeOverview";

type BundleEventRow = DatabaseRow<"bundle_events">;

export const ANALYTICS_SCAN_MAX_ROWS = 50_000;
export const ANALYTICS_MATERIALIZATION_LIMIT = ANALYTICS_SCAN_MAX_ROWS + 1;
export const ANALYTICS_SCAN_PAGE_SIZE = 1_000;

export type AnalyticsScanScope = {
  readonly database: DatabaseCapabilityRuntime;
  readonly cutoffMs: number;
};

type EventActivityRequest = {
  readonly rows: readonly BundleEventRow[];
  readonly window: BundleEventAnalyticsWindow;
  readonly cutoffMs: number;
};

export const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const compareEventNewest = (
  left: BundleEventRow,
  right: BundleEventRow,
): number =>
  right.received_at_ms - left.received_at_ms ||
  compareCodePoints(right.id, left.id);

const withCutoff = (
  where: readonly DatabaseWhere<"bundle_events">[] | undefined,
  cutoffMs: number,
): readonly DatabaseWhere<"bundle_events">[] => [
  ...(where ?? []),
  { field: "received_at_ms", operator: "lt", value: cutoffMs },
];

export const materializeEventRows = async (
  scope: AnalyticsScanScope,
  where?: readonly DatabaseWhere<"bundle_events">[],
): Promise<readonly BundleEventRow[]> => {
  const rows: BundleEventRow[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  while (rows.length < ANALYTICS_MATERIALIZATION_LIMIT) {
    const limit = Math.min(
      ANALYTICS_SCAN_PAGE_SIZE,
      ANALYTICS_MATERIALIZATION_LIMIT - rows.length,
    );
    const page = await scope.database.findMany({
      model: "bundle_events",
      where: withCutoff(where, scope.cutoffMs),
      limit,
      offset,
      orderBy: [
        { field: "received_at_ms", direction: "asc" },
        { field: "id", direction: "asc" },
      ],
    });
    if (page.length === 0) break;
    offset += page.length;
    for (const row of page) {
      if (seenIds.has(row.id)) continue;
      seenIds.add(row.id);
      rows.push(row);
    }
    if (rows.length > ANALYTICS_SCAN_MAX_ROWS) {
      throw new AnalyticsScanLimitExceededError(ANALYTICS_SCAN_MAX_ROWS);
    }
    if (page.length < limit) break;
  }
  return rows;
};

export const materializeActiveRows = async (
  scope: AnalyticsScanScope,
  window: ActiveInstallationWindow,
): Promise<readonly BundleEventRow[]> => {
  const definition = getActiveWindowDefinition(window);
  const durationMs = definition.bucketCount * definition.bucketSizeMs;
  return materializeEventRows(scope, [
    {
      field: "received_at_ms",
      operator: "gte",
      value: scope.cutoffMs - durationMs,
    },
    {
      field: "type",
      operator: "in",
      value: ACTIVE_BUNDLE_EVENT_TYPES,
    },
  ]);
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

export const getWindowRange = (
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

export const materializeRowsForWindow = (
  scope: AnalyticsScanScope,
  window: BundleEventAnalyticsWindow,
  where: readonly DatabaseWhere<"bundle_events">[],
): Promise<readonly BundleEventRow[]> => {
  const range =
    window === "all" ? undefined : getWindowRange(window, scope.cutoffMs);
  return materializeEventRows(scope, [
    ...where,
    ...(range
      ? ([
          {
            field: "received_at_ms",
            operator: "gte",
            value: range.rangeStart,
          },
        ] satisfies readonly DatabaseWhere<"bundle_events">[])
      : []),
  ]);
};

const bucketStart = (receivedAtMs: number, sizeMs: number): number =>
  sizeMs === 60 * 60 * 1000
    ? startOfUtcHour(receivedAtMs)
    : startOfUtcDay(receivedAtMs);

const createSeries = (request: EventActivityRequest) => {
  const range =
    request.window === "all"
      ? undefined
      : getWindowRange(request.window, request.cutoffMs);
  const sizeMs = range?.sizeMs ?? 24 * 60 * 60 * 1000;
  const installIdsByBucket = new Map<number, Set<string>>();
  let oldestMs = request.cutoffMs;
  for (const row of request.rows) {
    if (range && row.received_at_ms < range.rangeStart) continue;
    oldestMs = Math.min(oldestMs, row.received_at_ms);
    const start = bucketStart(row.received_at_ms, sizeMs);
    const installIds = installIdsByBucket.get(start) ?? new Set<string>();
    installIds.add(row.install_id);
    installIdsByBucket.set(start, installIds);
  }
  const first = range?.rangeStart ?? startOfUtcDay(oldestMs);
  const last = bucketStart(request.cutoffMs, sizeMs);
  return Array.from(
    { length: Math.floor((last - first) / sizeMs) + 1 },
    (_, index) => {
      const start = first + index * sizeMs;
      return {
        bucketStartMs: start,
        value: installIdsByBucket.get(start)?.size ?? 0,
      };
    },
  );
};

export const collectEventActivity = (request: EventActivityRequest) => {
  const range =
    request.window === "all"
      ? undefined
      : getWindowRange(request.window, request.cutoffMs);
  const rows = range
    ? request.rows.filter(
        ({ received_at_ms }) =>
          received_at_ms >= range.rangeStart &&
          received_at_ms < request.cutoffMs,
      )
    : request.rows;
  const installs = new Set<string>();
  const installsByCohort = new Map<string, Set<string>>();
  for (const row of rows) {
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
    series: createSeries({ ...request, rows }),
  };
};
