import type { CloudflareLifecyclePlatform } from "./cloudflareLifecycle";
import {
  type CloudflareTelemetryD1Database,
  queryAll,
} from "./cloudflareTelemetryD1";

export type CloudflareLifecycleMetricsTotals = {
  readonly active: number;
  readonly recovered: number;
};

export type CloudflareLifecycleMetricsBundle = {
  readonly active: number;
  readonly bundleId: string;
  readonly channel?: string;
  readonly lastSeenAt: string | null;
  readonly platform?: CloudflareLifecyclePlatform;
  readonly recovered: number;
};

export type CloudflareLifecycleMetrics = {
  readonly bundles: readonly CloudflareLifecycleMetricsBundle[];
  readonly series: readonly [];
  readonly totals: CloudflareLifecycleMetricsTotals;
};

type ActiveLifecycleMetricRow = {
  readonly active: number;
  readonly bundle_id: string;
  readonly channel: string | null;
  readonly last_seen_at: string | null;
  readonly platform: string | null;
};

type RecoveredLifecycleMetricRow = {
  readonly crashed_bundle_id: string | null;
  readonly recovered: number;
};

type LifecycleAccumulator = {
  readonly active: number;
  readonly bundleId: string;
  readonly channel?: string;
  readonly lastSeenAt: string | null;
  readonly platform?: CloudflareLifecyclePlatform;
  readonly recovered: number;
};

const emptyLifecycleAccumulator = (bundleId: string): LifecycleAccumulator => ({
  active: 0,
  bundleId,
  lastSeenAt: null,
  recovered: 0,
});

const normalizePlatform = (
  platform: string | null,
): CloudflareLifecyclePlatform | undefined => {
  if (platform === "ios" || platform === "android") {
    return platform;
  }
  return undefined;
};

const addActiveMetrics = (
  bundles: Map<string, LifecycleAccumulator>,
  row: ActiveLifecycleMetricRow,
) => {
  const current =
    bundles.get(row.bundle_id) ?? emptyLifecycleAccumulator(row.bundle_id);
  bundles.set(row.bundle_id, {
    ...current,
    active: row.active,
    channel: row.channel ?? undefined,
    lastSeenAt: row.last_seen_at,
    platform: normalizePlatform(row.platform),
  });
};

const addRecoveredMetrics = (
  bundles: Map<string, LifecycleAccumulator>,
  row: RecoveredLifecycleMetricRow,
) => {
  if (!row.crashed_bundle_id) {
    return;
  }

  const current =
    bundles.get(row.crashed_bundle_id) ??
    emptyLifecycleAccumulator(row.crashed_bundle_id);
  bundles.set(row.crashed_bundle_id, {
    ...current,
    recovered: row.recovered,
  });
};

export const getCloudflareLifecycleMetrics = async (
  db: CloudflareTelemetryD1Database,
): Promise<CloudflareLifecycleMetrics> => {
  const [activeRows, recoveredRows] = await Promise.all([
    queryAll<ActiveLifecycleMetricRow>(
      db,
      `
        SELECT
          COUNT(*) AS active,
          bundle_id,
          MIN(channel) AS channel,
          MAX(last_seen_at) AS last_seen_at,
          MIN(platform) AS platform
        FROM bundle_install_state
        GROUP BY bundle_id
      `,
    ),
    queryAll<RecoveredLifecycleMetricRow>(
      db,
      `
        SELECT crashed_bundle_id, COUNT(*) AS recovered
        FROM bundle_lifecycle_events
        WHERE event_type = 'recovered' AND crashed_bundle_id IS NOT NULL
        GROUP BY crashed_bundle_id
      `,
    ),
  ]);
  const bundles = new Map<string, LifecycleAccumulator>();

  for (const row of activeRows) {
    addActiveMetrics(bundles, row);
  }
  for (const row of recoveredRows) {
    addRecoveredMetrics(bundles, row);
  }

  const bundleMetrics = [...bundles.values()].sort((left, right) =>
    left.bundleId.localeCompare(right.bundleId),
  );

  return {
    bundles: bundleMetrics,
    series: [],
    totals: {
      active: bundleMetrics.reduce((sum, bundle) => sum + bundle.active, 0),
      recovered: bundleMetrics.reduce(
        (sum, bundle) => sum + bundle.recovered,
        0,
      ),
    },
  };
};
