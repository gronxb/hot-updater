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
        series: [{ startMs: 0, downloads: 4, launches: 9, failedLaunches: 1 }],
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
      adoption: null,
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
      intervalMs: 3_600_000,
    });
  });

  it("sums a release's hourly points into days and adoption intervals from its deployment", async () => {
    const hour = 3_600_000;
    const day = 24 * hour;
    // A UUIDv7 whose timestamp is day 6, 13:20 UTC.
    const deployedAtMs = 6 * day + 13 * hour + 20 * 60_000;
    const releaseId = `${deployedAtMs
      .toString(16)
      .padStart(12, "0")
      .replace(/^(.{8})(.{4})$/, "$1-$2")}-7000-8000-000000000001`;
    const point = (startMs: number, downloads: number, launches = 0) => ({
      startMs,
      downloads,
      launches,
      failedLaunches: 0,
    });
    const hourly = Array.from({ length: 7 * 24 }, (_, index) =>
      point(index * hour, 0),
    );
    hourly[12] = point(12 * hour, 0, 5);
    hourly[6 * 24 + 13] = point(6 * day + 13 * hour, 3, 2);
    hourly[6 * 24 + 14] = point(6 * day + 14 * hour, 1);
    hourly[6 * 24 + 20] = point(6 * day + 20 * hour, 2, 1);
    const getReleaseActivity = vi.fn(async () => ({
      ...result,
      data: [
        {
          metrics: { ...result.data[0]!.metrics, series: hourly },
        },
      ],
    }));
    const report = await getRecoveryReport(
      {
        getReleaseActivity,
        getDistributionHistory,
      } as unknown as InsightsModel,
      { platform: "ios", channel: "production", releaseId, window: "7d" },
      7 * day,
    );
    expect(report.points).toEqual([
      { startMs: 0, dailyActiveInstallations: 5, failedLaunches: 0 },
      { startMs: 6 * day, dailyActiveInstallations: 3, failedLaunches: 0 },
    ]);
    // Six-hour intervals from 13:00, the deployment's hour.
    expect(report.adoption).toEqual({
      deployedAtMs,
      intervalMs: 6 * hour,
      points: [
        { startMs: 6 * day + 13 * hour, downloads: 4, totalDownloads: 4 },
        { startMs: 6 * day + 19 * hour, downloads: 2, totalDownloads: 6 },
      ],
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
