import { createPluginTestHarness } from "@hot-updater/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleEventRow, parseBundleEventRequest } from "./eventInput";
import { createInsightsModel, createInsightsProvider, insights } from "./index";

const launch = (fields: Record<string, unknown> = {}) =>
  new Request("https://example.com/events", {
    method: "POST",
    body: JSON.stringify({
      type: "UNCHANGED",
      installId: "install-1",
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "1",
      fingerprintHash: null,
      sdkVersion: "1.0.0",
      fromBundleId: null,
      fromReleaseId: null,
      toBundleId: "019a0000-0000-7000-8000-000000000000",
      toReleaseId: null,
      updateStrategy: null,
      ...fields,
    }),
  });

describe("parseBundleEventRequest", () => {
  it("reads the native build's built-in bundle ID", async () => {
    await expect(
      parseBundleEventRequest(
        launch({ minBundleId: "019a0000-0000-7000-8000-000000000000" }),
      ),
    ).resolves.toMatchObject({
      minBundleId: "019a0000-0000-7000-8000-000000000000",
    });
  });

  it("records a report without the built-in bundle ID, or with a malformed one", async () => {
    for (const minBundleId of [undefined, null, "", 7, "x".repeat(37)]) {
      await expect(
        parseBundleEventRequest(launch({ minBundleId })),
      ).resolves.toMatchObject({ type: "UNCHANGED", minBundleId: null });
    }
  });
});

describe("a newer SDK's report age on this server", () => {
  const MADE_ID = "019a2a0d-5a80-7000-8000-000000000001";
  const ARRIVED = Date.parse("2026-10-16T01:10:00Z");
  /** 25h40m: what a report held since 2026-10-14T23:30Z says. */
  const AGE_MS = 92_400_000;
  const download = (fields: Record<string, unknown> = {}) =>
    launch({
      eventId: MADE_ID,
      type: "UPDATE_DOWNLOADED",
      fromBundleId: "bundle-1",
      fromReleaseId: "release-1",
      toBundleId: "bundle-2",
      toReleaseId: "release-2",
      updateStrategy: "appVersion",
      ...fields,
    });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: ARRIVED });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the same report with or without it", async () => {
    await expect(
      parseBundleEventRequest(download({ ageMs: AGE_MS })),
    ).resolves.toEqual(await parseBundleEventRequest(download()));
  });

  it("records it on arrival, in the arrival hour", async () => {
    const harness = await createPluginTestHarness(insights(), {
      now: () => Date.now(),
    });
    const model = createInsightsModel(harness.api);
    await createInsightsProvider(model).appendBundleEvent(
      await parseBundleEventRequest(download({ ageMs: AGE_MS })),
    );

    const start = Date.parse("2026-10-14T23:00:00Z");
    const points = await model.countEventSeries({
      filter: {
        platform: "ios",
        channel: "production",
        type: "UPDATE_DOWNLOADED",
        toBundleId: "bundle-2",
      },
      timeRange: { start, end: Date.parse("2026-10-16T02:00:00Z") },
      intervalMs: 3_600_000,
    });
    expect(
      points.flatMap(({ startMs, events }) =>
        events === 0 ? [] : [[new Date(startMs).toISOString(), events]],
      ),
    ).toEqual([["2026-10-16T01:00:00.000Z", 1]]);
    const [head] = await model.findLatestEvents({ installId: "install-1" });
    expect(head?.received_at_ms).toBe(ARRIVED);
    expect(Object.keys(head?.metadata ?? {}).sort()).toEqual(
      Object.keys(
        createBundleEventRow(await parseBundleEventRequest(download()))
          .metadata,
      ).sort(),
    );
  });
});
