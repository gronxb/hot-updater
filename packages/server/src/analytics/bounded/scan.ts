import type {
  ActiveInstallationWindow,
  BundleEventAnalyticsWindow,
} from "../domain";
import { AnalyticsScanLimitExceededError } from "../errors";
import type {
  AnalyticsPersistence,
  BundleEventPersistenceRow,
} from "../persistence";
import {
  ACTIVE_BUNDLE_EVENT_TYPES,
  getActiveWindowDefinition,
} from "./activeOverview";

export const ANALYTICS_SCAN_MAX_ROWS = 50_000;
export const ANALYTICS_MATERIALIZATION_LIMIT = ANALYTICS_SCAN_MAX_ROWS + 1;
export const ANALYTICS_SCAN_PAGE_SIZE = 1_000;

export type AnalyticsScanScope = {
  readonly persistence: AnalyticsPersistence;
  readonly cutoffMs: number;
};

type EventActivityRequest = {
  readonly rows: readonly BundleEventPersistenceRow[];
  readonly window: BundleEventAnalyticsWindow;
  readonly cutoffMs: number;
};

export const compareCodePoints = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export const compareEventNewest = (
  left: BundleEventPersistenceRow,
  right: BundleEventPersistenceRow,
): number =>
  right.received_at_ms - left.received_at_ms ||
  compareCodePoints(right.id, left.id);

const compareEventOldest = (
  left: { readonly received_at_ms: number; readonly id: string },
  right: { readonly received_at_ms: number; readonly id: string },
): number =>
  left.received_at_ms - right.received_at_ms ||
  compareCodePoints(left.id, right.id);

export const materializeEventRows = async (
  scope: AnalyticsScanScope,
): Promise<readonly BundleEventPersistenceRow[]> => {
  const rows: BundleEventPersistenceRow[] = [];
  const seenIds = new Set<string>();
  let after: { readonly receivedAtMs: number; readonly id: string } | undefined;
  while (rows.length < ANALYTICS_MATERIALIZATION_LIMIT) {
    const limit = Math.min(
      ANALYTICS_SCAN_PAGE_SIZE,
      ANALYTICS_MATERIALIZATION_LIMIT - rows.length,
    );
    const page = await scope.persistence.scan({
      beforeReceivedAtMs: scope.cutoffMs,
      ...(after === undefined ? {} : { after }),
      limit,
    });
    if (page.length === 0) break;
    if (page.length > limit) throw new AnalyticsPersistenceOrderError();
    let previous =
      after === undefined
        ? undefined
        : { received_at_ms: after.receivedAtMs, id: after.id };
    for (const row of page) {
      if (
        row.received_at_ms >= scope.cutoffMs ||
        (previous !== undefined && compareEventOldest(previous, row) >= 0) ||
        seenIds.has(row.id)
      ) {
        throw new AnalyticsPersistenceOrderError();
      }
      seenIds.add(row.id);
      rows.push(row);
      previous = row;
    }
    const last = page.at(-1);
    if (last !== undefined) {
      after = { receivedAtMs: last.received_at_ms, id: last.id };
    }
    if (rows.length > ANALYTICS_SCAN_MAX_ROWS) {
      throw new AnalyticsScanLimitExceededError(ANALYTICS_SCAN_MAX_ROWS);
    }
  }
  return rows;
};

export class AnalyticsPersistenceOrderError extends Error {
  readonly name = "AnalyticsPersistenceOrderError";

  constructor() {
    super("Analytics persistence did not advance its scan cursor.");
  }
}

export const materializeActiveRows = async (
  scope: AnalyticsScanScope,
  window: ActiveInstallationWindow,
): Promise<readonly BundleEventPersistenceRow[]> => {
  const definition = getActiveWindowDefinition(window);
  const durationMs = definition.bucketCount * definition.bucketSizeMs;
  return (await materializeEventRows(scope)).filter(
    (row) =>
      row.received_at_ms >= scope.cutoffMs - durationMs &&
      ACTIVE_BUNDLE_EVENT_TYPES.includes(row.type),
  );
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
      sizeMs: 60 * 60 * 1_000,
      rangeStart: startOfUtcHour(now) - 23 * 60 * 60 * 1_000,
    };
  }
  const days = window === "7d" ? 7 : 30;
  return {
    sizeMs: 24 * 60 * 60 * 1_000,
    rangeStart: startOfUtcDay(now) - (days - 1) * 24 * 60 * 60 * 1_000,
  };
};

export const materializeRowsForWindow = async (
  scope: AnalyticsScanScope,
  window: BundleEventAnalyticsWindow,
): Promise<readonly BundleEventPersistenceRow[]> => {
  const rows = await materializeEventRows(scope);
  if (window === "all") return rows;
  const range = getWindowRange(window, scope.cutoffMs);
  return rows.filter(
    ({ received_at_ms }) => received_at_ms >= range.rangeStart,
  );
};

const bucketStart = (receivedAtMs: number, sizeMs: number): number =>
  sizeMs === 60 * 60 * 1_000
    ? startOfUtcHour(receivedAtMs)
    : startOfUtcDay(receivedAtMs);

const createSeries = (request: EventActivityRequest) => {
  const range =
    request.window === "all"
      ? undefined
      : getWindowRange(request.window, request.cutoffMs);
  const sizeMs = range?.sizeMs ?? 24 * 60 * 60 * 1_000;
  const installIdsByBucket = new Map<number, Set<string>>();
  let oldestMs = request.cutoffMs;
  for (const row of request.rows) {
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
  const rows =
    range === undefined
      ? request.rows
      : request.rows.filter(
          ({ received_at_ms }) =>
            received_at_ms >= range.rangeStart &&
            received_at_ms < request.cutoffMs,
        );
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
