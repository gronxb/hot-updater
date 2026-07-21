import { describe, expect, it, vi } from "vitest";

import { BUNDLE_EVENT_SCAN_PAGE_SIZE } from "./bundleEventScan";
import { createDatabasePluginCore } from "./databasePluginCore";
import {
  currentBundle,
  resolveFileUrl,
  targetBundle,
  type TestContext,
} from "./databasePluginCore.testFixtures";
import { createBundleEventPlugin } from "./databasePluginCoreEvent.testFixtures";
import { supportsAnalytics } from "./types";

describe("createDatabasePluginCore bundle events", () => {
  it("appends bundle events and derives summary/search/history methods", async () => {
    const plugin = createBundleEventPlugin();
    const core = createDatabasePluginCore(plugin, resolveFileUrl);
    if (!supportsAnalytics(core.api)) {
      throw new Error("Expected Analytics support.");
    }
    const context: TestContext = {
      env: { assetHost: "https://assets.example.com" },
    };
    const nowValues = [
      1_725_000_000_000, 1_725_000_000_000, 1_725_000_003_000,
      1_725_000_003_000, 1_725_000_006_000, 1_725_000_006_000,
      1_725_000_006_001, 1_725_000_006_001, 1_725_000_006_001,
    ];
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(() => nowValues.shift() ?? 0);

    await core.api.appendBundleEvent(
      {
        type: "UPDATE_APPLIED",
        installId: "install-1",
        fromBundleId: currentBundle.id,
        toBundleId: targetBundle.id,
        userId: "user-1",
        username: "alice",
        platform: "ios",
        appVersion: "1.0.0",
        channel: "production",
        cohort: "default",
        updateStrategy: "appVersion",
        fingerprintHash: null,
      },
      context,
    );
    await core.api.appendBundleEvent(
      {
        type: "RECOVERED",
        installId: "install-2",
        fromBundleId: targetBundle.id,
        toBundleId: currentBundle.id,
        userId: "user-2",
        username: "bob",
        platform: "android",
        appVersion: "1.0.1",
        channel: "production",
        cohort: "beta",
        updateStrategy: "fingerprint",
        fingerprintHash: "fp-2",
      },
      context,
    );
    await core.api.appendBundleEvent(
      {
        type: "UPDATE_APPLIED",
        installId: "install-1",
        fromBundleId: targetBundle.id,
        toBundleId: targetBundle.id,
        userId: "user-1",
        username: "alice",
        platform: "ios",
        appVersion: "1.0.2",
        channel: "production",
        cohort: "default",
        updateStrategy: "appVersion",
        fingerprintHash: null,
      },
      context,
    );
    const summary = await core.api.getBundleEventSummary(
      targetBundle.id,
      context,
    );
    const search = await core.api.searchInstallations("ali", 10, 0, context);
    const history = await core.api.getInstallationHistory(
      "install-1",
      10,
      0,
      context,
    );

    expect(summary).toEqual({ installed: 1, recovered: 1 });
    expect(search).toEqual({
      data: [
        {
          installId: "install-1",
          username: "alice",
          userId: "user-1",
          lastKnownBundleId: targetBundle.id,
          latestStatus: "UPDATE_APPLIED",
          platform: "ios",
          appVersion: "1.0.2",
          channel: "production",
          cohort: "default",
          receivedAtMs: 1_725_000_006_000,
        },
      ],
      pagination: { total: 1, limit: 10, offset: 0 },
    });
    expect(history.data).toHaveLength(2);
    expect(history.data[0]).toMatchObject({
      type: "UPDATE_APPLIED",
      toBundleId: targetBundle.id,
      receivedAtMs: 1_725_000_006_000,
    });
    expect(history.data[1]).toMatchObject({
      type: "UPDATE_APPLIED",
      fromBundleId: currentBundle.id,
      receivedAtMs: 1_725_000_000_000,
    });
    expect(history.pagination).toEqual({ total: 2, limit: 10, offset: 0 });
    now.mockRestore();
  });

  it("builds windowed bundle event analytics with non-cumulative series", async () => {
    const plugin = createBundleEventPlugin();
    const findMany = vi.spyOn(plugin, "findMany");
    const core = createDatabasePluginCore(plugin, resolveFileUrl);
    if (!supportsAnalytics(core.api)) {
      throw new Error("Expected Analytics support.");
    }
    const analyticsTime = Date.UTC(2026, 0, 1, 0, 30);
    const nowValues = [
      Date.UTC(2025, 11, 31, 23, 5),
      Date.UTC(2025, 11, 31, 23, 5),
      Date.UTC(2025, 11, 31, 23, 10),
      Date.UTC(2025, 11, 31, 23, 10),
      Date.UTC(2025, 11, 31, 23, 15),
      Date.UTC(2025, 11, 31, 23, 15),
      analyticsTime,
    ];
    const now = vi
      .spyOn(Date, "now")
      .mockImplementation(() => nowValues.shift() ?? 0);

    await core.api.appendBundleEvent({
      type: "UPDATE_APPLIED",
      installId: "install-a",
      fromBundleId: currentBundle.id,
      toBundleId: targetBundle.id,
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "alpha",
      updateStrategy: "appVersion",
      fingerprintHash: null,
    });
    await core.api.appendBundleEvent({
      type: "UPDATE_APPLIED",
      installId: "install-b",
      fromBundleId: currentBundle.id,
      toBundleId: targetBundle.id,
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "beta",
      updateStrategy: "appVersion",
      fingerprintHash: null,
    });
    await core.api.appendBundleEvent({
      type: "RECOVERED",
      installId: "install-c",
      fromBundleId: targetBundle.id,
      toBundleId: currentBundle.id,
      platform: "ios",
      appVersion: "1.0.0",
      channel: "production",
      cohort: "beta",
      updateStrategy: "appVersion",
      fingerprintHash: null,
    });
    const analytics = await core.api.getBundleEventAnalytics(
      targetBundle.id,
      "24h",
      10,
      0,
    );

    expect(analytics.summary).toEqual({ installed: 2, recovered: 1 });
    expect(analytics.series.installed.at(-1)).toEqual({
      bucketStartMs: Date.UTC(2026, 0, 1, 0, 0, 0),
      value: 0,
    });
    expect(analytics.series.recovered.at(-1)).toEqual({
      bucketStartMs: Date.UTC(2026, 0, 1, 0, 0, 0),
      value: 0,
    });
    expect(analytics.cohorts.installed).toEqual([
      { cohort: "alpha", value: 1 },
      { cohort: "beta", value: 1 },
    ]);
    expect(analytics.cohorts.recovered).toEqual([{ cohort: "beta", value: 1 }]);
    expect(analytics.recentEvents.pagination).toEqual({
      total: 3,
      limit: 10,
      offset: 0,
    });
    expect(analytics.recentEvents.data[0]).toMatchObject({ type: "RECOVERED" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: BUNDLE_EVENT_SCAN_PAGE_SIZE,
        offset: 0,
        where: [
          {
            field: "type",
            operator: "in",
            value: ["UPDATE_APPLIED", "RECOVERED"],
          },
          {
            field: "received_at_ms",
            operator: "gte",
            value: Date.UTC(2025, 11, 31, 1, 0),
          },
          {
            field: "received_at_ms",
            operator: "lt",
            value: Date.UTC(2026, 0, 1, 0, 30),
          },
        ],
        orderBy: [
          { field: "received_at_ms", direction: "asc" },
          { field: "id", direction: "asc" },
        ],
      }),
    );
    expect(findMany).toHaveBeenCalledOnce();
    now.mockRestore();
  });
});
