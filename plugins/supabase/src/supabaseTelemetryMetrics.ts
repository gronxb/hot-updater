import {
  createSupabaseError,
  type LifecycleMetrics,
  type LifecycleMetricsBundle,
  type LifecycleMetricsSeriesPoint,
  type MetricsDelta,
  type SupabaseTelemetryClient,
  isRecord,
} from "./supabaseTelemetryTypes";

export const normalizeObservedAt = (observedAt?: string): string =>
  new Date(observedAt ?? Date.now()).toISOString();

const resolveBucketStart = (observedAt: string): string => {
  const bucketStart = new Date(observedAt);
  bucketStart.setUTCMinutes(0, 0, 0);
  return bucketStart.toISOString();
};

type IncrementLifecycleMetricArgs = {
  readonly p_active_delta: number;
  readonly p_bucket_start: string;
  readonly p_bundle_id: string;
  readonly p_channel: string;
  readonly p_observed_at: string;
  readonly p_platform: string;
  readonly p_recovered_delta: number;
};

type LifecycleMetricRpcClient = {
  readonly rpc: (
    name: "increment_bundle_lifecycle_metric",
    params: IncrementLifecycleMetricArgs,
  ) => Promise<{ readonly error: unknown | null }>;
};

const isLifecycleMetricRpcClient = (
  value: unknown,
): value is LifecycleMetricRpcClient =>
  isRecord(value) && typeof value["rpc"] === "function";

export const recordMetricDelta = async (
  supabase: unknown,
  delta: MetricsDelta,
): Promise<void> => {
  if (!isLifecycleMetricRpcClient(supabase)) {
    throw new Error("Supabase client does not support lifecycle metric RPC");
  }

  const bucketStart = resolveBucketStart(delta.observedAt);
  const { error } = await supabase.rpc("increment_bundle_lifecycle_metric", {
    p_active_delta: delta.active,
    p_bucket_start: bucketStart,
    p_bundle_id: delta.bundleId,
    p_channel: delta.channel,
    p_observed_at: delta.observedAt,
    p_platform: delta.platform,
    p_recovered_delta: delta.recovered,
  });

  if (error) {
    throw createSupabaseError("Failed to increment lifecycle metric", error);
  }
};

export const readLifecycleMetrics = async (
  supabase: SupabaseTelemetryClient,
): Promise<LifecycleMetrics> => {
  const { data, error } = await supabase
    .from("bundle_lifecycle_metrics")
    .select("*")
    .order("bundle_id", { ascending: true })
    .order("bucket_start", { ascending: true });

  if (error) throw createSupabaseError("Failed to read metrics", error);

  const bundleMap = new Map<string, LifecycleMetricsBundle>();
  const series: LifecycleMetricsSeriesPoint[] = [];
  let active = 0;
  let recovered = 0;

  for (const row of data ?? []) {
    active += row.active_count;
    recovered += row.recovered_count;
    series.push({
      active: row.active_count,
      bucketStart: row.bucket_start,
      bundleId: row.bundle_id,
      recovered: row.recovered_count,
    });

    const current = bundleMap.get(row.bundle_id);
    bundleMap.set(row.bundle_id, {
      active: (current?.active ?? 0) + row.active_count,
      bundleId: row.bundle_id,
      channel: row.channel,
      lastSeenAt:
        current?.lastSeenAt && current.lastSeenAt > row.last_seen_at
          ? current.lastSeenAt
          : row.last_seen_at,
      platform: row.platform,
      recovered: (current?.recovered ?? 0) + row.recovered_count,
    });
  }

  return {
    bundles: Array.from(bundleMap.values()).sort((left, right) =>
      left.bundleId.localeCompare(right.bundleId),
    ),
    series,
    totals: { active, recovered },
  };
};
