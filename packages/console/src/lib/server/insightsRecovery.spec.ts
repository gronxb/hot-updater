// @vitest-environment node
import {
  createInsightsProvider,
  type InsightsModel,
} from "@hot-updater/server/plugins/insights";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getRecoveryReport } from "./insightsRecovery";

const history = {
  coverage: { kind: "complete" as const, sinceMs: 0 },
  points: [],
  measuredAtMs: 0,
};
const getDistributionHistory = vi.fn(async () => history);

const result = {
  coverage: { kind: "complete" as const, sinceMs: 0 },
  data: [
    {
      // The model's field names; the report renames them.
      metrics: {
        downloads: 4,
        launches: 9,
        failedLaunches: 1,
        uniqueUsers: 7,
        series: [{ startMs: 0, launches: 9, failedLaunches: 1 }],
      },
    },
  ],
  measuredAtMs: 100,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("release health aggregate query", () => {
  it("reads a channel/platform scope directly for the resolved period", async () => {
    const getReleaseActivity = vi.fn(async () => result);
    const report = await getRecoveryReport(
      {
        getReleaseActivity,
        getDistributionHistory,
      } as unknown as InsightsModel,
      { platform: "ios", channel: "production", window: "7d" },
      8 * 3_600_000,
    );
    expect(getReleaseActivity).toHaveBeenCalledWith({
      scope: { platform: "ios", channel: "production" },
      timeRange: { start: 0, end: 8 * 3_600_000 },
    });
    expect(getDistributionHistory).toHaveBeenCalledWith({
      platform: "ios",
      channel: "production",
      timeRange: { start: 0, end: 86_400_000 },
    });
    expect(report.distribution).toBe(history);
    expect(report).toMatchObject({
      downloads: 4,
      activeDays: 9,
      failedLaunches: 1,
      activeInstallations: 7,
      points: [{ startMs: 0, dailyActiveInstallations: 9, failedLaunches: 1 }],
    });
  });

  it("uses an exact release reference for drilldown", async () => {
    const getReleaseActivity = vi.fn(async () => result);
    await getRecoveryReport(
      {
        getReleaseActivity,
        getDistributionHistory,
      } as unknown as InsightsModel,
      {
        platform: "android",
        channel: "preview",
        releaseId: "release-a",
        window: "24h",
      },
      48 * 3_600_000,
    );
    expect(getReleaseActivity).toHaveBeenCalledWith({
      releases: [
        {
          releaseId: "release-a",
          platform: "android",
          channel: "preview",
        },
      ],
      timeRange: {
        start: 24 * 3_600_000,
        end: 48 * 3_600_000,
      },
    });
  });

  it("ends a rolling window with the current hour, where the reporting overview ends", async () => {
    const now = 48 * 3_600_000 + 15 * 60_000;
    vi.useFakeTimers({ now });
    const getReleaseActivity = vi.fn(async () => result);
    const report = await getRecoveryReport(
      {
        getReleaseActivity,
        getDistributionHistory,
      } as unknown as InsightsModel,
      { platform: "ios", channel: "production", window: "24h" },
      now,
    );
    expect(getReleaseActivity).toHaveBeenCalledWith({
      scope: { platform: "ios", channel: "production" },
      timeRange: {
        start: 25 * 3_600_000,
        end: 49 * 3_600_000,
      },
    });
    const overview = await createInsightsProvider({
      countLatestEvents: async () => 0,
    } as unknown as InsightsModel).getReportingOverview({
      platform: "ios",
      channel: "production",
      window: "24h",
    });
    // Release health counters keep whole hours, so the period stays a rolling
    // 24 hours; the overview starts with the UTC day that period reaches into.
    expect(report).toMatchObject({
      startMs: 25 * 3_600_000,
      endMs: overview.beforeReceivedAtMs,
    });
  });
});
