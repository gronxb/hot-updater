import type { HotUpdaterCoreApi, ReleaseRow } from "@hot-updater/plugin-core";
import type { InsightsModel } from "@hot-updater/server/plugins/insights";

import { insightsPeriodEnd, recoveryWindows } from "../insights-recovery";
import {
  DOWNLOADS_CANDIDATES,
  type DownloadsRelease,
  type DownloadsReleaseInput,
  type DownloadsReleaseResult,
  type DownloadsReleasesInput,
  readDownloadsReleaseInput,
  readDownloadsReleasesInput,
  readReleaseDownloadsInput,
  type ReleaseDownloadsInput,
  type ReleaseDownloadsSeries,
} from "../release-downloads";

type ReleaseReads = Pick<
  HotUpdaterCoreApi,
  "findChannelByName" | "getRelease" | "listReleases"
>;

/** Rows read past a focused release to find the bundle before it. */
const PREVIOUS_ROWS = 4;

const labelOf = (release: ReleaseRow): DownloadsRelease => ({
  releaseId: release.id,
  deployedAtMs: release.created_at_ms,
  message: release.message,
  targetAppVersion: release.target_app_version,
});

// A rollback to the built-in bundle has nothing to download.
const bundles = (releases: readonly ReleaseRow[]) =>
  releases.filter((release) => release.kind === "BUNDLE").map(labelOf);

/**
 * The newest bundle deployments of a channel and platform, newest first: one
 * read of the channel and one of its newest releases.
 */
export async function listDownloadsReleases(
  core: ReleaseReads,
  input: DownloadsReleasesInput,
): Promise<readonly DownloadsRelease[]> {
  const { platform, channel } = readDownloadsReleasesInput(input);
  const row = await core.findChannelByName(channel);
  if (row === null) return [];
  return bundles(
    await core.listReleases({
      filter: { kind: "channelPlatform", channelId: row.id, platform },
      order: "desc",
      limit: DOWNLOADS_CANDIDATES,
    }),
  );
}

/**
 * One bundle deployment of the channel and platform, for a chart that names
 * a bundle the newest ones leave out, and with `withPrevious` the bundle
 * deployed before it.
 */
export async function getDownloadsRelease(
  core: ReleaseReads,
  input: DownloadsReleaseInput,
): Promise<DownloadsReleaseResult> {
  const { platform, channel, releaseId, withPrevious } =
    readDownloadsReleaseInput(input);
  const [row, release] = await Promise.all([
    core.findChannelByName(channel),
    core.getRelease(releaseId),
  ]);
  if (
    row === null ||
    release === null ||
    release.kind !== "BUNDLE" ||
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
 * One bundle's download reports in each interval of the period: its counters
 * alone, never its sketches or the release table.
 */
export async function getReleaseDownloads(
  model: Pick<InsightsModel, "getReleaseActivity">,
  input: ReleaseDownloadsInput,
  now = Date.now(),
): Promise<ReleaseDownloadsSeries> {
  const { platform, channel, window, endMs, releaseId } =
    readReleaseDownloadsInput(input);
  const { durationMs, intervalMs } = recoveryWindows[window];
  const end = Math.min(endMs, insightsPeriodEnd(now));
  const start = Math.max(0, end - durationMs);
  const result = await model.getReleaseActivity({
    releases: [{ releaseId, platform, channel }],
    timeRange: { start, end },
    intervalMs,
  });
  const metrics = result.data[0]?.metrics;
  return {
    releaseId,
    measuredAtMs: result.measuredAtMs,
    coverage: result.coverage,
    points: (metrics?.series ?? []).map(({ startMs, downloads }) => ({
      startMs,
      downloads,
    })),
    totalDownloads: metrics?.downloads ?? 0,
  };
}
