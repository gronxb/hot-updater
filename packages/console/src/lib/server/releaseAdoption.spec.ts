// @vitest-environment node
import type { ReleaseRow } from "@hot-updater/plugin-core";
import type { InsightsCountEventSeriesInput } from "@hot-updater/server/plugins";
import { describe, expect, it, vi } from "vitest";

import { crashRateOf, recommendsRollback } from "../release-adoption";
import {
  getAdoptionRelease,
  getBundleEvents,
  listAdoptionReleases,
} from "./releaseAdoption";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const row = (
  id: string,
  createdAtMs: number,
  overrides: Partial<ReleaseRow> = {},
): ReleaseRow => ({
  id,
  revision: 2,
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
  row("release-no-bundle", 8 * DAY, { bundle_id: null }),
  row("release-3", 7 * DAY, { enabled: false }),
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

describe("Release health bundles", () => {
  it("lists the newest bundle deployments with one read of the releases", async () => {
    const core = coreOf();
    const listed = await listAdoptionReleases(core, {
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
    // A release without a bundle has nothing to apply.
    expect(listed).toEqual([
      {
        releaseId: "release-4",
        bundleId: "bundle-release-4",
        deployedAtMs: 9 * DAY,
        targetAppVersion: "1.0.0",
        enabled: true,
        revision: 2,
      },
      expect.objectContaining({ releaseId: "release-3", enabled: false }),
      expect.objectContaining({ releaseId: "release-2" }),
    ]);
    await expect(
      listAdoptionReleases(core, { platform: "ios", channel: "beta" }),
    ).resolves.toEqual([]);
    expect(core.listReleases).toHaveBeenCalledOnce();
  });

  it("names one bundle of the scope, and finds the bundle deployed before it", async () => {
    const core = coreOf();
    await expect(
      getAdoptionRelease(core, {
        platform: "ios",
        channel: "production",
        releaseId: "release-3",
      }),
    ).resolves.toEqual({
      release: expect.objectContaining({ releaseId: "release-3" }),
    });
    expect(core.listReleases).not.toHaveBeenCalled();

    const withPrevious = await getAdoptionRelease(core, {
      platform: "ios",
      channel: "production",
      releaseId: "release-4",
      withPrevious: true,
    });
    // Past the release without a bundle, the bundle before it.
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

    // No other platform's or channel's release, and none without a bundle.
    for (const releaseId of ["release-android", "release-no-bundle", "none"])
      await expect(
        getAdoptionRelease(core, {
          platform: "ios",
          channel: "production",
          releaseId,
          withPrevious: true,
        }),
      ).resolves.toEqual({ release: null, previous: null });
  });
});

describe("Release health counts", () => {
  const modelOf = () => ({
    // Three reports in each interval read.
    countEventSeries: vi.fn(
      async ({ timeRange, intervalMs }: InsightsCountEventSeriesInput) =>
        Array.from(
          { length: (timeRange.end - timeRange.start) / intervalMs },
          (_, index) => ({
            startMs: timeRange.start + index * intervalMs,
            events: 3,
          }),
        ),
    ),
  });

  it("reads one bundle's downloads, launches, or crashes in the period's intervals", async () => {
    const model = modelOf();
    const launched = await getBundleEvents(
      model,
      {
        platform: "ios",
        channel: "production",
        window: "7d",
        endMs: 10 * DAY,
        bundleId: "bundle-1",
        type: "LAUNCHED",
      },
      10 * DAY - HOUR / 2,
    );
    // Launches add two series: apply reports, and the kept reports that
    // moved an installation to the bundle with no apply report.
    expect(model.countEventSeries).toHaveBeenCalledTimes(2);
    for (const type of ["UPDATE_APPLIED", "UNCHANGED"]) {
      expect(model.countEventSeries).toHaveBeenCalledWith({
        filter: {
          platform: "ios",
          channel: "production",
          type,
          toBundleId: "bundle-1",
        },
        timeRange: { start: 3 * DAY, end: 10 * DAY },
        intervalMs: 6 * HOUR,
      });
    }
    expect(launched).toMatchObject({
      bundleId: "bundle-1",
      type: "LAUNCHED",
      total: 168,
    });
    expect(launched.points).toHaveLength(28);
    expect(launched.points[0]).toMatchObject({ events: 6 });

    // Downloads are one series: the bundle's download hours, which count
    // the downloads a launch or crash implied too.
    model.countEventSeries.mockClear();
    const downloaded = await getBundleEvents(model, {
      platform: "ios",
      channel: "production",
      window: "7d",
      endMs: 10 * DAY,
      bundleId: "bundle-1",
      type: "DOWNLOADED",
    });
    expect(model.countEventSeries).toHaveBeenCalledExactlyOnceWith({
      filter: {
        platform: "ios",
        channel: "production",
        type: "UPDATE_DOWNLOADED",
        toBundleId: "bundle-1",
      },
      timeRange: { start: 3 * DAY, end: 10 * DAY },
      intervalMs: 6 * HOUR,
    });
    expect(downloaded).toMatchObject({ type: "DOWNLOADED", total: 84 });

    // A recovery names the bundle it crashed on.
    await getBundleEvents(model, {
      platform: "ios",
      channel: "production",
      window: "24h",
      endMs: 10 * DAY,
      bundleId: "bundle-1",
      type: "RECOVERED",
    });
    expect(model.countEventSeries).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filter: {
          platform: "ios",
          channel: "production",
          type: "RECOVERED",
          fromBundleId: "bundle-1",
        },
        intervalMs: HOUR,
      }),
    );
  });

  it("ends no later than the current hour, and takes only the end of an hour", async () => {
    const model = modelOf();
    await getBundleEvents(
      model,
      {
        platform: "ios",
        channel: "production",
        window: "24h",
        endMs: 12 * DAY,
        bundleId: "bundle-1",
        type: "RECOVERED",
      },
      10 * DAY - HOUR / 2,
    );
    expect(model.countEventSeries).toHaveBeenCalledWith(
      expect.objectContaining({
        timeRange: { start: 9 * DAY, end: 10 * DAY },
      }),
    );
    await expect(
      getBundleEvents(model, {
        platform: "ios",
        channel: "production",
        window: "24h",
        endMs: 10 * DAY + 1,
        bundleId: "bundle-1",
        type: "LAUNCHED",
      }),
    ).rejects.toThrow("Choose a platform, channel, period, and bundle.");
    // Release health charts downloads, launches, and recoveries only.
    await expect(
      getBundleEvents(model, {
        platform: "ios",
        channel: "production",
        window: "24h",
        endMs: 10 * DAY,
        bundleId: "bundle-1",
        type: "UPDATE_FAILED" as never,
      }),
    ).rejects.toThrow("Choose a platform, channel, period, and bundle.");
  });

  it("counts a crash rate over applies and crashes, and recommends a rollback from 5% of 20", () => {
    expect(crashRateOf(0, 0)).toEqual({ attempts: 0, rate: 0 });
    expect(crashRateOf(18, 2)).toEqual({ attempts: 20, rate: 0.1 });
    const enabled = { enabled: true };
    expect(recommendsRollback(enabled, 19, 1)).toBe(true);
    // 19 attempts are too few, 4.8% too low, and a disabled bundle is rolled back.
    expect(recommendsRollback(enabled, 18, 1)).toBe(false);
    expect(recommendsRollback(enabled, 40, 2)).toBe(false);
    expect(recommendsRollback({ enabled: false }, 18, 2)).toBe(false);
  });
});
