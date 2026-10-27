import type { HotUpdaterCoreApi, ReleaseRow } from "@hot-updater/plugin-core";
import type {
  InsightsBundleEventFilter,
  InsightsModel,
} from "@hot-updater/server/plugins";

import { insightsPeriodEnd, recoveryWindows } from "../insights-recovery";
import {
  ADOPTION_CANDIDATES,
  type AdoptionRelease,
  type HealthPlatform,
  type AdoptionReleaseInput,
  type AdoptionReleaseResult,
  type AdoptionReleasesInput,
  type BundleEventsInput,
  type BundleEventsSeries,
  readAdoptionReleaseInput,
  readAdoptionReleasesInput,
  readBundleEventsInput,
} from "../release-adoption";
import { addReleaseReachability } from "./releaseReachability";

type ReleaseReads = Pick<
  HotUpdaterCoreApi,
  "findChannelByName" | "getRelease" | "getReleaseCatalogRow" | "listReleases"
>;

/** Rows read past a focused release to find the bundle before it. */
const PREVIOUS_ROWS = 4;

const platformsOf = (platform: HealthPlatform) =>
  platform === "all" ? (["ios", "android"] as const) : [platform];

/**
 * Labels the releases that have a bundle, a release without one having
 * nothing to apply. A bundle is live when its scope's catalog still serves
 * it: one catalog read per scope of the enabled ones.
 */
const labelled = async (
  core: Pick<ReleaseReads, "getReleaseCatalogRow">,
  releases: readonly ReleaseRow[],
): Promise<AdoptionRelease[]> => {
  const bundles = releases.filter((release) => release.bundle_id);
  const live = new Set(
    (
      await addReleaseReachability(
        core,
        bundles.filter((release) => release.enabled),
      )
    )
      .filter((release) => !release.currentlyUnreachable)
      .map((release) => release.id),
  );
  return bundles.map((release) => ({
    releaseId: release.id,
    bundleId: release.bundle_id!,
    platform: release.platform,
    deployedAtMs: release.created_at_ms,
    targetAppVersion: release.target_app_version,
    enabled: release.enabled,
    live: live.has(release.id),
    revision: release.revision,
  }));
};

/**
 * A channel's newest bundle deployments, of one platform or both, newest
 * first: per platform, its newest releases and its newest enabled ones, so
 * a live bundle older than the newest still shows.
 */
export async function listAdoptionReleases(
  core: ReleaseReads,
  input: AdoptionReleasesInput,
): Promise<readonly AdoptionRelease[]> {
  const { platform, channel } = readAdoptionReleasesInput(input);
  const row = await core.findChannelByName(channel);
  if (row === null) return [];
  const lists = await Promise.all(
    platformsOf(platform).flatMap((each) =>
      [{}, { enabled: true }].map((enabled) =>
        core.listReleases({
          filter: {
            kind: "channelPlatform",
            channelId: row.id,
            platform: each,
            ...enabled,
          },
          order: "desc",
          limit: ADOPTION_CANDIDATES,
        }),
      ),
    ),
  );
  const releases = new Map(
    lists.flat().map((release) => [release.id, release]),
  );
  return labelled(
    core,
    [...releases.values()].sort(
      (left, right) => right.created_at_ms - left.created_at_ms,
    ),
  );
}

/**
 * One bundle deployment of the channel, for a focus the newest ones leave
 * out, and with `withPrevious` the bundle deployed before it on its
 * platform.
 */
export async function getAdoptionRelease(
  core: ReleaseReads,
  input: AdoptionReleaseInput,
): Promise<AdoptionReleaseResult> {
  const { platform, channel, releaseId, withPrevious } =
    readAdoptionReleaseInput(input);
  const [row, release] = await Promise.all([
    core.findChannelByName(channel),
    core.getRelease(releaseId),
  ]);
  if (
    row === null ||
    release === null ||
    !release.bundle_id ||
    (platform !== "all" && release.platform !== platform) ||
    release.channel_id !== row.id
  )
    return withPrevious ? { release: null, previous: null } : { release: null };
  if (!withPrevious) return { release: (await labelled(core, [release]))[0]! };
  // Newest first, `after` a release lists older ones.
  const older = await core.listReleases({
    filter: {
      kind: "channelPlatform",
      channelId: row.id,
      platform: release.platform,
    },
    order: "desc",
    after: release.id,
    limit: PREVIOUS_ROWS,
  });
  const [label, previous] = await labelled(core, [release, ...older]);
  return { release: label!, previous: previous ?? null };
}

/**
 * One bundle's counts of one type in each interval of the period, from
 * their hourly counts, never the events or the release table. Downloads are
 * the bundle's download hours, which count the downloads a launch or crash
 * implied too. Launches add two series: apply reports, and the kept
 * UNCHANGED reports that moved an installation to the bundle with no apply
 * report.
 */
export async function getBundleEvents(
  model: Pick<InsightsModel, "countEventSeries">,
  input: BundleEventsInput,
  now = Date.now(),
): Promise<BundleEventsSeries> {
  const { platform, channel, window, endMs, bundleId, type } =
    readBundleEventsInput(input);
  const { durationMs, intervalMs } = recoveryWindows[window];
  const end = Math.min(endMs, insightsPeriodEnd(now));
  const timeRange = { start: Math.max(0, end - durationMs), end };
  const series = (filter: InsightsBundleEventFilter) =>
    model.countEventSeries({ filter, timeRange, intervalMs });
  const points =
    type === "RECOVERED"
      ? await series({ platform, channel, type, fromBundleId: bundleId })
      : type === "DOWNLOADED"
        ? await series({
            platform,
            channel,
            type: "UPDATE_DOWNLOADED",
            toBundleId: bundleId,
          })
        : await Promise.all([
            series({
              platform,
              channel,
              type: "UPDATE_APPLIED",
              toBundleId: bundleId,
            }),
            series({
              platform,
              channel,
              type: "UNCHANGED",
              toBundleId: bundleId,
            }),
          ]).then(([applied, moved]) =>
            applied.map((point, index) => ({
              startMs: point.startMs,
              events: point.events + (moved[index]?.events ?? 0),
            })),
          );
  return {
    bundleId,
    type,
    measuredAtMs: now,
    points,
    total: points.reduce((sum, point) => sum + point.events, 0),
  };
}
