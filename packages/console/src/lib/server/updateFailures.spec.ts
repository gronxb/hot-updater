// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { getUpdateFailuresReport, mergeUpdateFailures } from "./updateFailures";

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

  it("reads both platforms, one read each, as one report", async () => {
    const ios = {
      ...failures,
      coverage: { kind: "complete" as const, sinceMs: 2 * HOUR },
      checks: { failures: 1, failedInstallations: 1, activeInstallations: 40 },
      breakdown: [
        {
          stage: "download",
          reason: "network",
          events: 2,
          details: [
            {
              resource: "bundle",
              httpStatus: null,
              originCode: null,
              transport: "fetch",
              events: 2,
            },
          ],
        },
      ],
    };
    const android = {
      ...failures,
      measuredAtMs: 90,
      failedUpdates: 5,
      coverage: { kind: "complete" as const, sinceMs: 3 * HOUR },
      checks: { failures: 2, failedInstallations: 2, activeInstallations: 60 },
      breakdown: [
        {
          stage: "apply",
          reason: "disk",
          events: 3,
          details: [],
        },
        {
          stage: "download",
          reason: "network",
          events: 2,
          details: [
            {
              resource: "bundle",
              httpStatus: null,
              originCode: null,
              transport: "fetch",
              events: 1,
            },
            {
              resource: "patch",
              httpStatus: 404,
              originCode: null,
              transport: "fetch",
              events: 1,
            },
          ],
        },
      ],
    };
    const getUpdateFailures = vi.fn(
      async ({ platform }: { platform: "ios" | "android" }) =>
        platform === "ios" ? ios : android,
    );
    const report = await getUpdateFailuresReport(
      { getUpdateFailures },
      { platform: "all", channel: "production", window: "24h" },
      30 * HOUR + 5,
    );
    expect(getUpdateFailures.mock.calls.map(([input]) => input)).toEqual(
      ["ios", "android"].map((platform) => ({
        platform,
        channel: "production",
        timeRange: { start: 7 * HOUR, end: 31 * HOUR },
      })),
    );
    expect(report).toEqual({
      // Complete from where both are.
      coverage: { kind: "complete", sinceMs: 3 * HOUR },
      measuredAtMs: 90,
      failedUpdates: 7,
      failedInstallations: 4,
      downloads: 16,
      patchDownloads: 6,
      patchFallbacks: 2,
      checks: { failures: 3, failedInstallations: 3, activeInstallations: 100 },
      breakdown: [
        {
          stage: "download",
          reason: "network",
          events: 4,
          details: [
            expect.objectContaining({ resource: "bundle", events: 3 }),
            expect.objectContaining({ resource: "patch", events: 1 }),
          ],
        },
        { stage: "apply", reason: "disk", events: 3, details: [] },
      ],
      startMs: 7 * HOUR,
      endMs: 31 * HOUR,
    });
  });

  it("reads a release's failures on its own platform only", async () => {
    const getUpdateFailures = vi.fn(async () => failures);
    const getRelease = vi.fn(async () => ({ platform: "android" as const }));
    await getUpdateFailuresReport(
      { getUpdateFailures },
      {
        platform: "all",
        channel: "production",
        releaseId: "release-1",
        window: "24h",
      },
      30 * HOUR + 5,
      { getRelease } as never,
    );
    expect(getRelease).toHaveBeenCalledExactlyOnceWith("release-1");
    expect(getUpdateFailures).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ platform: "android", releaseId: "release-1" }),
    );
  });

  it("calls a merged period partial when either platform's is", () => {
    expect(
      mergeUpdateFailures([
        failures,
        { ...failures, coverage: { kind: "partial", sinceMs: null } },
      ]).coverage,
    ).toEqual({ kind: "partial", sinceMs: null });
  });
});
