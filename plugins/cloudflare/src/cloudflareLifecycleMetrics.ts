import {
  deriveTelemetryLifecycleMetrics,
  type TelemetryAnalyticsEventRow,
  type TelemetryLifecycleMetrics,
} from "@hot-updater/plugin-core";

import {
  type CloudflareTelemetryD1Database,
  queryAll,
} from "./cloudflareTelemetryD1";

type AnalyticsEventRow = {
  readonly event_type: string;
  readonly id: string;
  readonly observed_at: string;
  readonly payload: string;
  readonly received_at: string;
};

export const getCloudflareLifecycleMetrics = async (
  db: CloudflareTelemetryD1Database,
): Promise<TelemetryLifecycleMetrics> => {
  const rows = await queryAll<AnalyticsEventRow>(
    db,
    `
      SELECT id, event_type, payload, observed_at, received_at
      FROM analytics_events
      ORDER BY observed_at ASC, received_at ASC
    `,
  );

  return deriveTelemetryLifecycleMetrics(
    rows.map((row) => ({
      eventType: row.event_type,
      id: row.id,
      observedAt: row.observed_at,
      payload: row.payload,
      receivedAt: row.received_at,
    })) satisfies TelemetryAnalyticsEventRow[],
  );
};
