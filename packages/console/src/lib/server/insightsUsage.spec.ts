// @vitest-environment node
import type { InsightsModel } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { getAppUsageReport } from "./insightsUsage";

const aggregate = {
  coverage: { kind: "complete" as const, sinceMs: 0 },
  activeInstallations: 3,
  points: [{ startMs: 0, installations: 3 }],
  appVersions: ["1.0.0"],
  versions: [{ name: "1.0.0", installations: 3 }],
  platforms: [{ name: "ios", installations: 3 }],
  bundleDistribution: [
    {
      appVersion: "1.0.0",
      platform: "ios" as const,
      releaseId: "release-a",
      installations: 3,
    },
  ],
  measuredAtMs: 100,
};

describe("App usage aggregate query", () => {
  it("preserves filters and requests the configured interval without raw events", async () => {
    const getAppUsage = vi.fn(async () => aggregate);
    const report = await getAppUsageReport(
      { getAppUsage } as unknown as InsightsModel,
      {
        platform: "ios",
        channel: "production",
        appVersion: "1.0.0",
        window: "7d",
      },
      8 * 3_600_000,
    );
    expect(getAppUsage).toHaveBeenCalledWith({
      platform: "ios",
      channel: "production",
      appVersion: "1.0.0",
      timeRange: { start: 0, end: 8 * 3_600_000 },
      intervalMs: 6 * 3_600_000,
    });
    expect(report.activeInstallations).toBe(3);
    expect(report.bundleDistribution).toEqual(aggregate.bundleDistribution);
  });

  it("keeps valid empty aggregate data distinct from unavailable reads", async () => {
    const getAppUsage = vi.fn(async () => ({
      ...aggregate,
      activeInstallations: 0,
      points: [],
      bundleDistribution: [],
    }));
    const report = await getAppUsageReport(
      { getAppUsage } as unknown as InsightsModel,
      { platform: "all", channel: "production", window: "24h" },
      24 * 3_600_000,
    );
    expect(report.activeInstallations).toBe(0);
    expect(report.truncated).toBe(false);
  });

  it("does not widen usage beyond the current completed hour", async () => {
    const getAppUsage = vi.fn(async () => aggregate);
    await getAppUsageReport(
      { getAppUsage } as unknown as InsightsModel,
      { platform: "all", channel: "production", window: "24h" },
      48 * 3_600_000 + 15 * 60_000,
    );
    expect(getAppUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        timeRange: {
          start: 24 * 3_600_000,
          end: 48 * 3_600_000,
        },
      }),
    );
  });
});
