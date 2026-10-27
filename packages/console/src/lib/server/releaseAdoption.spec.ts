// @vitest-environment node
import type { HotUpdaterCoreApi, ReleaseRow } from "@hot-updater/plugin-core";
import type { InsightsCountEventSeriesInput } from "@hot-updater/server/plugins";
import { describe, expect, it, vi } from "vitest";

import {
  type AdoptionRelease,
  crashRateOf,
  defaultAdoptionReleases,
  readBundleEventsInput,
  recommendsRollback,
} from "../release-adoption";
import {
  getAdoptionRelease,
  getBundleEvents,
  listAdoptionReleases,
} from "./releaseAdoption";

// The scope's catalog no longer serves release-2: release-4 took its devices.
const reachability = vi.hoisted(() => ({
  served: new Set(["release-4", "release-android"]),
}));
vi.mock("./releaseReachability", () => ({
  addReleaseReachability: vi.fn(
    async (_core: unknown, releases: readonly ReleaseRow[]) =>
      releases.map((release) => ({
        ...release,
        currentlyUnreachable: !reachability.served.has(release.id),
      })),
  ),
}));

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
const androidReleases = [
  row("release-android", 6 * DAY, { platform: "android" }),
];

type ListInput = Parameters<HotUpdaterCoreApi["listReleases"]>[0];

const coreOf = () => ({
  findChannelByName: vi.fn(async (name: string) =>
    name === "production" ? { id: "channel-production", name } : null,
  ),
  listReleases: vi.fn(async ({ filter, after }: ListInput) => {
    const { platform, enabled } = filter as Extract<
      typeof filter,
      { kind: "channelPlatform" }
    >;
    const listed = (platform === "android" ? androidReleases : releases).filter(
      (release) => !enabled || release.enabled,
    );
    return after === undefined
      ? listed
      : listed.slice(listed.findIndex((release) => release.id === after) + 1);
  }),
  getReleaseCatalogRow: vi.fn(async () => null),
  getRelease: vi.fn(async (id: string) =>
    id === "release-android"
      ? row(id, DAY, { platform: "android" })
      : (releases.find((release) => release.id === id) ?? null),
  ),
});

describe("Release health bundles", () => {
  it("lists a platform's newest and newest enabled bundle deployments, marking the live ones", async () => {
    const core = coreOf();
    const listed = await listAdoptionReleases(core, {
      platform: "ios",
      channel: "production",
    });
    expect(core.listReleases.mock.calls).toEqual(
      [{}, { enabled: true }].map((enabled) => [
        {
          filter: {
            kind: "channelPlatform",
            channelId: "channel-production",
            platform: "ios",
            ...enabled,
          },
          order: "desc",
          limit: 10,
        },
      ]),
    );
    // A release without a bundle has nothing to apply, and one listed by
    // both reads shows once.
    expect(listed).toEqual([
      {
        releaseId: "release-4",
        bundleId: "bundle-release-4",
        platform: "ios",
        deployedAtMs: 9 * DAY,
        targetAppVersion: "1.0.0",
        enabled: true,
        live: true,
        revision: 2,
      },
      expect.objectContaining({
        releaseId: "release-3",
        enabled: false,
        live: false,
      }),
      expect.objectContaining({ releaseId: "release-2", live: false }),
    ]);
    // Only enabled bundles can be live, so only theirs are checked.
    const { addReleaseReachability } = await import("./releaseReachability");
    expect(
      vi
        .mocked(addReleaseReachability)
        .mock.lastCall![1].map((release) => release.id),
    ).toEqual(["release-4", "release-2"]);
    await expect(
      listAdoptionReleases(core, { platform: "ios", channel: "beta" }),
    ).resolves.toEqual([]);
    expect(core.listReleases).toHaveBeenCalledTimes(2);
  });

  it("lists both platforms together, newest first", async () => {
    const core = coreOf();
    const listed = await listAdoptionReleases(core, {
      platform: "all",
      channel: "production",
    });
    expect(core.listReleases).toHaveBeenCalledTimes(4);
    expect(
      listed.map(({ releaseId, platform }) => `${platform}:${releaseId}`),
    ).toEqual([
      "ios:release-4",
      "ios:release-3",
      "android:release-android",
      "ios:release-2",
    ]);
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
    expect(withPrevious).toEqual({
      release: expect.objectContaining({ releaseId: "release-4", live: true }),
      previous: expect.objectContaining({
        releaseId: "release-3",
        live: false,
      }),
    });
    // With both platforms, a release of either, and the one before it on
    // its own platform.
    await expect(
      getAdoptionRelease(core, {
        platform: "all",
        channel: "production",
        releaseId: "release-android",
        withPrevious: true,
      }),
    ).resolves.toEqual({
      release: expect.objectContaining({ platform: "android", live: true }),
      previous: null,
    });
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

describe("Release health's default bundles", () => {
  const label = (
    releaseId: string,
    platform: "ios" | "android",
    live: boolean,
  ): AdoptionRelease => ({
    releaseId,
    bundleId: `bundle-${releaseId}`,
    platform,
    deployedAtMs: 0,
    targetAppVersion: null,
    enabled: live,
    live,
    revision: 1,
  });
  // Newest first: two rolled back, then what devices get now.
  const candidates = [
    label("ios-disabled", "ios", false),
    label("android-disabled", "android", false),
    label("ios-live", "ios", true),
    label("android-live", "android", true),
    label("ios-live-older", "ios", true),
  ];

  it("compares what devices get now, never a newer bundle no device gets", () => {
    expect(defaultAdoptionReleases(candidates, "ios")).toEqual([
      "ios-live",
      "ios-live-older",
    ]);
    // Both platforms: the newest live bundle of each.
    expect(defaultAdoptionReleases(candidates, "all")).toEqual([
      "ios-live",
      "android-live",
    ]);
    // One platform without a live bundle leaves the other's alone.
    expect(
      defaultAdoptionReleases(
        candidates.filter((release) => release.platform === "ios"),
        "all",
      ),
    ).toEqual(["ios-live"]);
  });

  it("falls back to the newest when nothing is live", () => {
    expect(
      defaultAdoptionReleases(
        candidates.filter((release) => !release.live),
        "all",
      ),
    ).toEqual(["ios-disabled", "android-disabled"]);
    expect(defaultAdoptionReleases([], "all")).toEqual([]);
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
    // A bundle's counts are read on its own platform.
    expect(() =>
      readBundleEventsInput({
        platform: "all" as "ios",
        channel: "production",
        window: "24h",
        endMs: 10 * DAY,
        bundleId: "bundle-1",
        type: "LAUNCHED",
      }),
    ).toThrow("Choose a platform, channel, period, and bundle.");
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
