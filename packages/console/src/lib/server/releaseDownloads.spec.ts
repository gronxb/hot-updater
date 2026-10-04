// @vitest-environment node
import type { ReleaseRow } from "@hot-updater/plugin-core";
import type { InsightsGetReleaseActivityInput } from "@hot-updater/server/plugins/insights";
import { describe, expect, it, vi } from "vitest";

import {
  getDownloadsRelease,
  getReleaseDownloads,
  listDownloadsReleases,
} from "./releaseDownloads";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const row = (
  id: string,
  createdAtMs: number,
  overrides: Partial<ReleaseRow> = {},
): ReleaseRow => ({
  id,
  revision: 1,
  scope_key: "scope",
  channel_id: "channel-production",
  platform: "ios",
  kind: "BUNDLE",
  bundle_id: `bundle-${id}`,
  strategy: "APP_VERSION",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  enabled: true,
  should_force_update: false,
  message: null,
  rollout_cohort_count: 1000,
  target_cohorts: [],
  operation: "DEPLOY",
  source_release_id: null,
  created_at_ms: createdAtMs,
  updated_at_ms: createdAtMs,
  ...overrides,
});

// Newest first, as the release index lists them.
const releases = [
  row("release-4", 9 * DAY, { message: "Newest" }),
  row("release-embedded", 8 * DAY, { kind: "EMBEDDED", bundle_id: null }),
  row("release-3", 7 * DAY),
  row("release-2", 5 * DAY),
];

const coreOf = () => ({
  findChannelByName: vi.fn(async (name: string) =>
    name === "production" ? { id: "channel-production", name } : null,
  ),
  listReleases: vi.fn(async ({ after }: { after?: string }) =>
    after === undefined
      ? releases
      : releases.slice(
          releases.findIndex((release) => release.id === after) + 1,
        ),
  ),
  getRelease: vi.fn(async (id: string) =>
    id === "release-android"
      ? row(id, DAY, { platform: "android" })
      : (releases.find((release) => release.id === id) ?? null),
  ),
});

describe("downloads releases", () => {
  it("lists the newest bundle deployments with one read of the releases", async () => {
    const core = coreOf();
    const listed = await listDownloadsReleases(core, {
      platform: "ios",
      channel: "production",
    });
    expect(core.listReleases).toHaveBeenCalledExactlyOnceWith({
      filter: {
        kind: "channelPlatform",
        channelId: "channel-production",
        platform: "ios",
      },
      order: "desc",
      limit: 10,
    });
    // A rollback to the built-in bundle has nothing to download.
    expect(listed).toEqual([
      {
        releaseId: "release-4",
        deployedAtMs: 9 * DAY,
        message: "Newest",
        targetAppVersion: "1.0.0",
      },
      {
        releaseId: "release-3",
        deployedAtMs: 7 * DAY,
        message: null,
        targetAppVersion: "1.0.0",
      },
      {
        releaseId: "release-2",
        deployedAtMs: 5 * DAY,
        message: null,
        targetAppVersion: "1.0.0",
      },
    ]);
    await expect(
      listDownloadsReleases(core, { platform: "ios", channel: "beta" }),
    ).resolves.toEqual([]);
    expect(core.listReleases).toHaveBeenCalledOnce();
  });

  it("names one bundle of the scope, and finds the bundle deployed before it", async () => {
    const core = coreOf();
    await expect(
      getDownloadsRelease(core, {
        platform: "ios",
        channel: "production",
        releaseId: "release-3",
      }),
    ).resolves.toEqual({
      release: expect.objectContaining({ releaseId: "release-3" }),
    });
    expect(core.listReleases).not.toHaveBeenCalled();

    const withPrevious = await getDownloadsRelease(core, {
      platform: "ios",
      channel: "production",
      releaseId: "release-4",
      withPrevious: true,
    });
    // Past the rollback, the bundle before it.
    expect(withPrevious.previous?.releaseId).toBe("release-3");
    expect(core.listReleases).toHaveBeenCalledWith({
      filter: {
        kind: "channelPlatform",
        channelId: "channel-production",
        platform: "ios",
      },
      order: "desc",
      after: "release-4",
      limit: 4,
    });

    // No other platform's or channel's release, and no rollback.
    for (const releaseId of ["release-android", "release-embedded", "none"])
      await expect(
        getDownloadsRelease(core, {
          platform: "ios",
          channel: "production",
          releaseId,
          withPrevious: true,
        }),
      ).resolves.toEqual({ release: null, previous: null });
  });
});

describe("release downloads", () => {
  const modelOf = () => ({
    // Three downloads in each interval read.
    getReleaseActivity: vi.fn(
      async ({ timeRange, intervalMs }: InsightsGetReleaseActivityInput) => ({
        coverage: { kind: "complete" as const, sinceMs: 0 },
        measuredAtMs: 42,
        data: [
          {
            metrics: {
              downloads: 99,
              launches: 0,
              failedLaunches: 0,
              series: Array.from(
                { length: (timeRange!.end - timeRange!.start) / intervalMs! },
                (_, index) => ({
                  startMs: timeRange!.start + index * intervalMs!,
                  downloads: 3,
                  launches: 1,
                  failedLaunches: 0,
                }),
              ),
            },
          },
        ],
      }),
    ),
  });

  it("reads one bundle's counters in the period's intervals", async () => {
    const model = modelOf();
    const series = await getReleaseDownloads(
      model,
      {
        platform: "ios",
        channel: "production",
        window: "7d",
        endMs: 10 * DAY,
        releaseId: "release-4",
      },
      10 * DAY - HOUR / 2,
    );
    expect(model.getReleaseActivity).toHaveBeenCalledExactlyOnceWith({
      releases: [
        { releaseId: "release-4", platform: "ios", channel: "production" },
      ],
      timeRange: { start: 3 * DAY, end: 10 * DAY },
      intervalMs: 6 * HOUR,
    });
    expect(series).toMatchObject({
      releaseId: "release-4",
      measuredAtMs: 42,
      totalDownloads: 99,
    });
    expect(series.points).toHaveLength(28);
    expect(series.points[0]).toEqual({ startMs: 3 * DAY, downloads: 3 });
  });

  it("ends no later than the current hour, and takes only the end of an hour", async () => {
    const model = modelOf();
    await getReleaseDownloads(
      model,
      {
        platform: "ios",
        channel: "production",
        window: "24h",
        endMs: 12 * DAY,
        releaseId: "release-4",
      },
      10 * DAY - HOUR / 2,
    );
    expect(model.getReleaseActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        timeRange: { start: 9 * DAY, end: 10 * DAY },
        intervalMs: HOUR,
      }),
    );
    await expect(
      getReleaseDownloads(model, {
        platform: "ios",
        channel: "production",
        window: "24h",
        endMs: 10 * DAY + 1,
        releaseId: "release-4",
      }),
    ).rejects.toThrow("Choose a platform, channel, period, and bundle.");
  });
});
