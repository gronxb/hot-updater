import {
  deriveTelemetryLifecycleMetrics,
  type TelemetryAnalyticsEventRow,
  type TelemetryLifecycleMetrics,
  type TelemetryLifecyclePayload,
} from "@hot-updater/plugin-core";

import {
  createSupabaseError,
  type SupabaseTelemetryClient,
} from "./supabaseTelemetryTypes";

export const normalizeObservedAt = (observedAt?: string): string =>
  new Date(observedAt ?? Date.now()).toISOString();

export const getLifecycleMetrics = async (
  supabase: SupabaseTelemetryClient,
): Promise<TelemetryLifecycleMetrics> => {
  const { data, error } = await supabase
    .from("analytics_events")
    .select("*")
    .order("observed_at", { ascending: true })
    .order("received_at", { ascending: true });

  if (error) throw createSupabaseError("Failed to read metrics", error);

  return deriveTelemetryLifecycleMetrics(
    (data ?? []).map((row) => ({
      eventType: row.event_type,
      id: row.id,
      observedAt: row.observed_at,
      payload: row.payload as TelemetryLifecyclePayload,
      receivedAt: row.received_at,
    })) satisfies TelemetryAnalyticsEventRow[],
  );
};
