import { createDatabaseAnalyticsRuntime } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createSupabaseNotifyAppReadyResult,
  createNotifyRequest,
  createOperations,
  notifyPayload,
  tables,
} from "./supabaseTelemetryTestSupport";

const createRequiredAnalytics = (
  operations: ReturnType<typeof createOperations>,
) => {
  const analytics = createDatabaseAnalyticsRuntime(operations);
  const { issueTelemetryKey, rotateTelemetryKey } = analytics;
  if (!issueTelemetryKey || !rotateTelemetryKey) {
    throw new TypeError(
      "Supabase telemetry test runtime is missing key operations.",
    );
  }

  return { issueTelemetryKey, rotateTelemetryKey };
};

describe("supabase telemetry key auth", () => {
  beforeEach(() => {
    tables.telemetryKeys.clear();
    tables.lifecycleEvents.clear();
    tables.lifecycleMetrics.clear();
  });

  it("writes only telemetry key hash and suffix when issuing and rotating", async () => {
    const operations = createOperations();
    const analytics = createRequiredAnalytics(operations);

    const issued = await analytics.issueTelemetryKey();
    const storedIssued = tables.telemetryKeys.get("default");

    expect(issued.telemetryKey).toMatch(/^hutk_.+/);
    expect(issued.telemetryKeySuffix).toBe(issued.telemetryKey.slice(-8));
    expect(storedIssued).toMatchObject({
      key_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      key_suffix: issued.telemetryKeySuffix,
    });
    expect(JSON.stringify(storedIssued)).not.toContain(issued.telemetryKey);

    const rotated = await analytics.rotateTelemetryKey();
    const storedRotated = tables.telemetryKeys.get("default");

    expect(rotated.telemetryKey).not.toBe(issued.telemetryKey);
    expect(storedRotated).toMatchObject({
      key_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      key_suffix: rotated.telemetryKeySuffix,
    });
    expect(JSON.stringify(storedRotated)).not.toContain(rotated.telemetryKey);
  });

  it("authorizes notifyAppReady with only the current telemetry key", async () => {
    const operations = createOperations();
    const analytics = createRequiredAnalytics(operations);
    const issued = await analytics.issueTelemetryKey();

    const accepted = await createSupabaseNotifyAppReadyResult({
      operations,
      request: createNotifyRequest(issued.telemetryKey),
    });
    const rotated = await analytics.rotateTelemetryKey();
    const stale = await createSupabaseNotifyAppReadyResult({
      operations,
      request: createNotifyRequest(issued.telemetryKey, {
        ...notifyPayload,
        eventId: "event-stale",
      }),
    });
    const current = await createSupabaseNotifyAppReadyResult({
      operations,
      request: createNotifyRequest(rotated.telemetryKey, {
        ...notifyPayload,
        eventId: "event-current",
      }),
    });

    expect(accepted).toEqual({
      body: { accepted: true, deduped: false },
      status: 202,
    });
    expect(stale.status).toBe(401);
    expect(current.status).toBe(202);
  });

  it("rejects malformed telemetry keys and credential channels", async () => {
    const operations = createOperations();
    const analytics = createRequiredAnalytics(operations);
    const issued = await analytics.issueTelemetryKey();
    const cases = [
      createNotifyRequest(null),
      createNotifyRequest("huc_deploy_key_12345678"),
      createNotifyRequest("hutk_random_12345678"),
      createNotifyRequest("hutk_"),
      createNotifyRequest(null, notifyPayload, {
        headers: { authorization: `Bearer ${issued.telemetryKey}` },
      }),
      createNotifyRequest(null, notifyPayload, {
        headers: { cookie: `telemetry=${issued.telemetryKey}` },
      }),
      new Request(
        `https://runtime.example.com/api/notify-app-ready?telemetryKey=${encodeURIComponent(
          issued.telemetryKey,
        )}`,
        {
          body: JSON.stringify(notifyPayload),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
    ];

    for (const request of cases) {
      const result = await createSupabaseNotifyAppReadyResult({
        operations,
        request,
      });

      expect(result.status).toBe(401);
    }
  });

  it("rejects recovered lifecycle operations without crashed bundle before writing", async () => {
    const operations = createOperations();

    await expect(
      operations.insertLifecycleEvent({
        ...notifyPayload,
        eventId: "event-recovered-without-crashed-bundle",
        status: "RECOVERED",
      }),
    ).rejects.toThrow("Recovered lifecycle events require crashedBundleId.");

    expect(tables.lifecycleEvents.size).toBe(0);
    expect(tables.lifecycleMetrics.size).toBe(0);
  });
});
