// @vitest-environment node

import type {
  DatabaseModels,
  ReleaseReference,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { getAggregatedRecoveryReport } from "./insightsRecovery";

const HOUR = 3_600_000;
const now = 48 * HOUR;
const input = {
  platform: "ios",
  channel: "production",
  window: "24h",
} as const;

const models = () =>
  ({
    channels: {
      list: vi.fn(async () => ({
        channels: [{ id: "production-id", name: "production" }],
      })),
    },
    releases: {
      findMany: vi.fn(async () => [
        {
          id: "00000000-0000-7000-8000-000000000001",
          channel_id: "production-id",
          platform: "ios",
        },
      ]),
      findById: vi.fn(),
    },
    insights: {
      getReleaseActivity: vi.fn(async ({ releases }) => ({
        coverage: { kind: "complete" as const, sinceMs: 0 },
        data: releases.map((release: ReleaseReference) => ({
          release,
          summary: {
            activeInstallations: 789,
            pendingInstallations: 4,
            downloadedInstallations: 107,
            recoveredInstallations: 3,
          },
          series: [
            {
              startMs: 47 * HOUR,
              downloadedReports: 5,
              appliedReports: 4,
              recoveredReports: 1,
            },
          ],
          measuredAtMs: now,
        })),
      })),
    },
  }) as unknown as Pick<DatabaseModels, "channels" | "releases" | "insights">;

describe("aggregated Bundle Activity", () => {
  it("uses one bounded aggregate query and preserves lifetime/current summary", async () => {
    const database = models();
    const report = await getAggregatedRecoveryReport(database, input, now);

    expect(database.insights.getReleaseActivity).toHaveBeenCalledOnce();
    expect(database.insights.getReleaseActivity).toHaveBeenCalledWith({
      releases: [
        {
          releaseId: "00000000-0000-7000-8000-000000000001",
          platform: "ios",
          channel: "production",
        },
      ],
      timeRange: { start: 24 * HOUR, end: 48 * HOUR },
    });
    expect(report.series[0]).toMatchObject({
      activeInstallations: 789,
      pendingInstallations: 4,
      downloadedInstallations: 107,
      recoveredInstallations: 3,
    });
    expect(report.series[0]?.points.at(-1)).toMatchObject({
      downloadedInstallations: 5,
      applied: 4,
      recovered: 1,
    });
  });

  it("does not query aggregate buckets when the scope has no releases", async () => {
    const database = models();
    database.releases.findMany = vi.fn(async () => []);

    const report = await getAggregatedRecoveryReport(database, input, now);

    expect(database.insights.getReleaseActivity).not.toHaveBeenCalled();
    expect(report.series).toEqual([]);
  });

  it("reads hourly buckets only for the selected release", async () => {
    const database = models();
    const [baseRelease] = await database.releases.findMany({ limit: 1 });
    if (!baseRelease) throw new Error("Missing release fixture");
    database.releases.findMany = vi.fn(async () => [
      {
        ...baseRelease,
        id: "00000000-0000-7000-8000-000000000002",
      },
      {
        ...baseRelease,
        id: "00000000-0000-7000-8000-000000000001",
      },
    ]);

    const report = await getAggregatedRecoveryReport(
      database,
      { ...input, releaseId: "00000000-0000-7000-8000-000000000001" },
      now,
    );

    expect(database.releases.findById).not.toHaveBeenCalled();
    expect(report.availableReleaseIds).toEqual([
      "00000000-0000-7000-8000-000000000002",
      "00000000-0000-7000-8000-000000000001",
    ]);
    expect(database.insights.getReleaseActivity).toHaveBeenCalledWith({
      releases: [
        {
          releaseId: "00000000-0000-7000-8000-000000000001",
          platform: "ios",
          channel: "production",
        },
      ],
      timeRange: { start: 24 * HOUR, end: 48 * HOUR },
    });
  });

  it("groups daily reports on UTC boundaries and marks clipped intervals", async () => {
    const database = models();
    const midday = 48 * HOUR + HOUR / 2;

    const report = await getAggregatedRecoveryReport(
      database,
      { ...input, window: "30d" },
      midday,
    );

    expect(report.series[0]?.points[0]).toMatchObject({
      startMs: -28 * 24 * HOUR,
      rangeStartMs: -28 * 24 * HOUR + HOUR,
      partial: true,
    });
    expect(report.series[0]?.points.at(-1)).toMatchObject({
      startMs: 2 * 24 * HOUR,
      endMs: midday,
      partial: true,
    });
  });

  it("preserves observed reports and leaves unknown partial intervals empty", async () => {
    const database = models();
    database.insights.getReleaseActivity = vi.fn(async ({ releases }) => ({
      coverage: { kind: "partial" as const, sinceMs: null },
      data: releases.map((release: ReleaseReference) => ({
        release,
        summary: {
          activeInstallations: 1,
          pendingInstallations: 0,
          downloadedInstallations: 1,
          recoveredInstallations: 0,
        },
        series: [
          {
            startMs: 47 * HOUR,
            downloadedReports: 1,
            appliedReports: 1,
            recoveredReports: 0,
          },
        ],
        measuredAtMs: now,
      })),
    }));

    const report = await getAggregatedRecoveryReport(database, input, now);

    expect(report.truncated).toBe(true);
    expect(report.sinceMs).toBe(24 * HOUR);
    expect(report.series[0]?.points[0]?.applied).toBeNull();
    expect(report.series[0]?.points.at(-1)).toMatchObject({
      downloadedInstallations: 1,
      applied: 1,
      recovered: 0,
    });
  });
});
