import { createDatabaseAnalyticsRuntime } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createSupabaseNotifyAppReadyResult,
  createNotifyRequest,
  createOperations,
  notifyPayload,
  recoveredPayload,
  tables,
} from "./supabaseTelemetryTestSupport";

const createRequiredAnalytics = (
  operations: ReturnType<typeof createOperations>,
) => {
  const analytics = createDatabaseAnalyticsRuntime(operations);
  const { issueTelemetryKey, readLifecycleMetrics } = analytics;
  if (!issueTelemetryKey || !readLifecycleMetrics) {
    throw new TypeError(
      "Supabase telemetry test runtime is missing lifecycle operations.",
    );
  }

  return { issueTelemetryKey, readLifecycleMetrics };
};

describe("supabase telemetry lifecycle metrics", () => {
  beforeEach(() => {
    tables.telemetryKeys.clear();
    tables.analyticsEvents.clear();
    tables.lifecycleEvents.clear();
    tables.lifecycleMetrics.clear();
  });

  it("returns lifecycle counts and series for ACTIVE and RECOVERED events", async () => {
    const operations = createOperations();
    const analytics = createRequiredAnalytics(operations);
    const issued = await analytics.issueTelemetryKey();

    await createSupabaseNotifyAppReadyResult({
      operations,
      request: createNotifyRequest(issued.telemetryKey),
    });
    await createSupabaseNotifyAppReadyResult({
      operations,
      request: createNotifyRequest(issued.telemetryKey, recoveredPayload),
    });

    const metrics = await analytics.readLifecycleMetrics();

    expect(metrics.totals).toEqual({ active: 2, recovered: 1 });
    expect(metrics.bundles).toEqual([
      {
        active: 1,
        bundleId: "018f0000-0000-7000-8000-000000000001",
        channel: "production",
        lastSeenAt: expect.any(String),
        platform: "ios",
        recovered: 1,
      },
      {
        active: 1,
        bundleId: "018f0000-0000-7000-8000-000000000002",
        channel: "production",
        lastSeenAt: expect.any(String),
        platform: "ios",
        recovered: 0,
      },
    ]);
    expect(metrics.series).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          active: 1,
          bundleId: "018f0000-0000-7000-8000-000000000001",
          recovered: 1,
        }),
        expect.objectContaining({
          active: 1,
          bundleId: "018f0000-0000-7000-8000-000000000002",
          recovered: 0,
        }),
      ]),
    );
  });

  it("accumulates repeated ACTIVE deltas for the same bundle hour through the atomic RPC", async () => {
    const operations = createOperations();
    const analytics = createRequiredAnalytics(operations);
    const issued = await analytics.issueTelemetryKey();
    const secondActivePayload = {
      ...notifyPayload,
      eventId: "event-active-second",
      installId: "install-active-second",
    } as const;

    await createSupabaseNotifyAppReadyResult({
      operations,
      request: createNotifyRequest(issued.telemetryKey),
    });
    await createSupabaseNotifyAppReadyResult({
      operations,
      request: createNotifyRequest(issued.telemetryKey, secondActivePayload),
    });

    const metrics = await analytics.readLifecycleMetrics();

    expect(metrics.totals).toEqual({ active: 2, recovered: 0 });
    expect(metrics.bundles).toEqual([
      expect.objectContaining({
        active: 2,
        bundleId: "018f0000-0000-7000-8000-000000000001",
        recovered: 0,
      }),
    ]);
  });
});
