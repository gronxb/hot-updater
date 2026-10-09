import type { HotUpdaterCoreApi, ReleaseRow } from "@hot-updater/plugin-core";
import type {
  InsightsBundleEventFilter,
  InsightsModel,
} from "@hot-updater/server/plugins";

import { insightsPeriodEnd, recoveryWindows } from "../insights-recovery";
import {
  ADOPTION_CANDIDATES,
  type AdoptionRelease,
  type AdoptionReleaseInput,
  type AdoptionReleaseResult,
  type AdoptionReleasesInput,
  type BundleEventsInput,
  type BundleEventsSeries,
  readAdoptionReleaseInput,
  readAdoptionReleasesInput,
  readBundleEventsInput,
} from "../release-adoption";

type ReleaseReads = Pick<
  HotUpdaterCoreApi,
  "findChannelByName" | "getRelease" | "listReleases"
>;

/** Rows read past a focused release to find the bundle before it. */
const PREVIOUS_ROWS = 4;

const labelOf = (release: ReleaseRow): AdoptionRelease => ({
  releaseId: release.id,
  bundleId: release.bundle_id!,
  deployedAtMs: release.created_at_ms,
  targetAppVersion: release.target_app_version,
  enabled: release.enabled,
  revision: release.revision,
});

// A rollback to the built-in bundle has nothing to apply.
const bundles = (releases: readonly ReleaseRow[]) =>
  releases
    .filter((release) => release.kind === "BUNDLE" && release.bundle_id)
    .map(labelOf);

/**
 * The newest bundle deployments of a channel and platform, newest first: one
 * read of the channel and one of its newest releases.
 */
export async function listAdoptionReleases(
  core: ReleaseReads,
  input: AdoptionReleasesInput,
): Promise<readonly AdoptionRelease[]> {
  const { platform, channel } = readAdoptionReleasesInput(input);
  const row = await core.findChannelByName(channel);
  if (row === null) return [];
  return bundles(
    await core.listReleases({
      filter: { kind: "channelPlatform", channelId: row.id, platform },
      order: "desc",
      limit: ADOPTION_CANDIDATES,
    }),
  );
}

/**
 * One bundle deployment of the channel and platform, for a focus the newest
 * ones leave out, and with `withPrevious` the bundle deployed before it.
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
    release.kind !== "BUNDLE" ||
    !release.bundle_id ||
    release.platform !== platform ||
    release.channel_id !== row.id
  )
    return withPrevious ? { release: null, previous: null } : { release: null };
  if (!withPrevious) return { release: labelOf(release) };
  // Newest first, `after` a release lists older ones.
  const older = await core.listReleases({
    filter: { kind: "channelPlatform", channelId: row.id, platform },
    order: "desc",
    after: release.id,
    limit: PREVIOUS_ROWS,
  });
  return { release: labelOf(release), previous: bundles(older)[0] ?? null };
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
