// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { getUpdateFailuresReport } from "./updateFailures";

const HOUR = 3_600_000;
const failures = {
  coverage: { kind: "complete" as const, sinceMs: 0 },
  measuredAtMs: 100,
  failedUpdates: 2,
  failedInstallations: 2,
  downloads: 8,
  patchDownloads: 3,
  patchFallbacks: 1,
};

describe("update failures report", () => {
  it("reads a period that ends with the current hour", async () => {
    const getUpdateFailures = vi.fn(async () => failures);
    const report = await getUpdateFailuresReport(
      { getUpdateFailures },
      { platform: "ios", channel: "production", window: "24h" },
      30 * HOUR + 5,
    );
    expect(getUpdateFailures).toHaveBeenCalledWith({
      platform: "ios",
      channel: "production",
      timeRange: { start: 7 * HOUR, end: 31 * HOUR },
    });
    expect(report).toEqual({
      ...failures,
      startMs: 7 * HOUR,
      endMs: 31 * HOUR,
    });
  });

  it("compares equal adjacent periods without treating missing prior traffic as zero", async () => {
    const getUpdateFailures = vi
      .fn()
      .mockResolvedValueOnce(failures)
      .mockResolvedValueOnce({
        ...failures,
        failedUpdates: 0,
        downloads: 0,
        coverage: { kind: "partial", sinceMs: null },
      });
    const report = await getUpdateFailuresReport(
      { getUpdateFailures },
      { platform: "ios", channel: "production", window: "24h" },
      60 * HOUR,
    );
    expect(getUpdateFailures.mock.calls).toEqual([
      [
        {
          platform: "ios",
          channel: "production",
          timeRange: { start: 36 * HOUR, end: 60 * HOUR },
        },
      ],
      [
        {
          platform: "ios",
          channel: "production",
          timeRange: { start: 12 * HOUR, end: 36 * HOUR },
        },
      ],
    ]);
    expect(report.previous).toEqual({
      attemptRate: null,
      checkRate: null,
      complete: false,
    });
  });

  it("reads a release since its first report without a window, and needs one for a channel", async () => {
    const getUpdateFailures = vi.fn(async () => failures);
    const report = await getUpdateFailuresReport(
      { getUpdateFailures },
      { platform: "android", channel: "beta", releaseId: "release-1" },
      HOUR,
    );
    expect(getUpdateFailures).toHaveBeenCalledWith({
      platform: "android",
      channel: "beta",
      releaseId: "release-1",
    });
    expect(report.startMs).toBeNull();
    await expect(
      getUpdateFailuresReport(
        { getUpdateFailures },
        { platform: "ios", channel: "production" },
      ),
    ).rejects.toThrow("Choose a platform, channel, and time window.");
  });
});
