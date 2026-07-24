import type { DatabaseRow } from "@hot-updater/plugin-core";

import type {
  ActiveInstallationOverview,
  ActiveInstallationWindow,
} from "../../domain";

type BundleEventRow = DatabaseRow<"bundle_events">;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const ACTIVE_BUNDLE_EVENT_TYPES = [
  "UPDATE_APPLIED",
  "RECOVERED",
  "UNCHANGED",
] as const;

const activeWindowDefinitions = {
  "24h": { bucketCount: 24, bucketSizeMs: HOUR_MS },
  "7d": { bucketCount: 7, bucketSizeMs: DAY_MS },
  "30d": { bucketCount: 30, bucketSizeMs: DAY_MS },
} as const satisfies Record<
  ActiveInstallationWindow,
  { readonly bucketCount: number; readonly bucketSizeMs: number }
>;

export const getActiveWindowDefinition = (window: ActiveInstallationWindow) =>
  activeWindowDefinitions[window];

type ActiveOverviewRequest = {
  readonly rows: readonly BundleEventRow[];
  readonly asOfMs: number;
  readonly window: ActiveInstallationWindow;
  readonly userId?: string;
};

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isNewer = (candidate: BundleEventRow, current: BundleEventRow): boolean =>
  candidate.received_at_ms > current.received_at_ms ||
  (candidate.received_at_ms === current.received_at_ms &&
    compareCodePoints(candidate.id, current.id) > 0);

export const collectActiveInstallationOverview = (
  request: ActiveOverviewRequest,
): ActiveInstallationOverview => {
  const definition = getActiveWindowDefinition(request.window);
  const durationMs = definition.bucketCount * definition.bucketSizeMs;
  const windowStartMs = request.asOfMs - durationMs;
  const rows = request.rows.filter(
    (row) =>
      row.received_at_ms >= windowStartMs &&
      row.received_at_ms < request.asOfMs,
  );
  const latestByInstall = new Map<string, BundleEventRow>();
  for (const row of rows) {
    const current = latestByInstall.get(row.install_id);
    if (!current || isNewer(row, current)) {
      latestByInstall.set(row.install_id, row);
    }
  }
  const selectedInstallIds = new Set(
    [...latestByInstall]
      .filter(
        ([, row]) =>
          request.userId === undefined || row.user_id === request.userId,
      )
      .map(([installId]) => installId),
  );
  const bundleCounts = new Map<string, number>();
  for (const installId of selectedInstallIds) {
    const row = latestByInstall.get(installId);
    if (!row) continue;
    bundleCounts.set(
      row.to_bundle_id,
      (bundleCounts.get(row.to_bundle_id) ?? 0) + 1,
    );
  }
  const latestByBucket = Array.from(
    { length: definition.bucketCount },
    () => new Map<string, BundleEventRow>(),
  );
  for (const row of rows) {
    if (!selectedInstallIds.has(row.install_id)) continue;
    const bucketIndex = Math.floor(
      (row.received_at_ms - windowStartMs) / definition.bucketSizeMs,
    );
    const bucket = latestByBucket[bucketIndex];
    const current = bucket?.get(row.install_id);
    if (bucket && (!current || isNewer(row, current))) {
      bucket.set(row.install_id, row);
    }
  }
  const bundleCountsByBucket = latestByBucket.map((bucket) => {
    const counts = new Map<string, number>();
    for (const row of bucket.values()) {
      counts.set(row.to_bundle_id, (counts.get(row.to_bundle_id) ?? 0) + 1);
    }
    return counts;
  });
  const bundleObservationTotals = new Map<string, number>();
  for (const counts of bundleCountsByBucket) {
    for (const [bundleId, count] of counts) {
      bundleObservationTotals.set(
        bundleId,
        (bundleObservationTotals.get(bundleId) ?? 0) + count,
      );
    }
  }
  return {
    asOfMs: request.asOfMs,
    window: request.window,
    activeInstallations: selectedInstallIds.size,
    series: latestByBucket.map((bucket, index) => ({
      bucketStartMs: windowStartMs + index * definition.bucketSizeMs,
      value: bucket.size,
    })),
    bundleSeries: [...bundleObservationTotals]
      .sort(
        ([leftId, leftTotal], [rightId, rightTotal]) =>
          rightTotal - leftTotal || compareCodePoints(leftId, rightId),
      )
      .map(([bundleId]) => ({
        bundleId,
        series: bundleCountsByBucket.map((counts, index) => ({
          bucketStartMs: windowStartMs + index * definition.bucketSizeMs,
          value: counts.get(bundleId) ?? 0,
        })),
      })),
    bundles: [...bundleCounts]
      .map(([bundleId, installations]) => ({ bundleId, installations }))
      .sort(
        (left, right) =>
          right.installations - left.installations ||
          compareCodePoints(left.bundleId, right.bundleId),
      ),
  };
};
