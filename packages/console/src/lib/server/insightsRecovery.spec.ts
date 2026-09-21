// @vitest-environment node
import type { InsightsModel } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { getRecoveryReport } from "./insightsRecovery";

const result = {
  coverage: { kind: "complete" as const, sinceMs: 0 },
  data: [
    {
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

describe("release health aggregate query", () => {
  it("reads a channel/platform scope directly for the resolved period", async () => {
    const getReleaseActivity = vi.fn(async () => result);
    const report = await getRecoveryReport(
      { getReleaseActivity } as unknown as InsightsModel,
      { platform: "ios", channel: "production", window: "7d" },
      8 * 3_600_000,
    );
    expect(getReleaseActivity).toHaveBeenCalledWith({
      scope: { platform: "ios", channel: "production" },
      timeRange: { start: 0, end: 8 * 3_600_000 },
    });
    expect(report).toMatchObject({
      downloads: 4,
      launches: 9,
      failedLaunches: 1,
      uniqueUsers: 7,
    });
  });

  it("uses an exact release reference for drilldown", async () => {
    const getReleaseActivity = vi.fn(async () => result);
    await getRecoveryReport(
      { getReleaseActivity } as unknown as InsightsModel,
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

  it("does not widen a rolling window past the current completed hour", async () => {
    const getReleaseActivity = vi.fn(async () => result);
    await getRecoveryReport(
      { getReleaseActivity } as unknown as InsightsModel,
      { platform: "ios", channel: "production", window: "24h" },
      48 * 3_600_000 + 15 * 60_000,
    );
    expect(getReleaseActivity).toHaveBeenCalledWith({
      scope: { platform: "ios", channel: "production" },
      timeRange: {
        start: 24 * 3_600_000,
        end: 48 * 3_600_000,
      },
    });
  });
});
