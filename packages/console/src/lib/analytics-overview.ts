import { normalizeRolloutCohortCount } from "@hot-updater/core";
import type { Bundle, ChannelRow, ReleaseRow } from "@hot-updater/plugin-core";

export type AnalyticsBundleMetadata = {
  readonly platform: "ios" | "android";
  readonly channel: string | null;
  readonly targetAppVersion: string | null;
  readonly fingerprintHash: string | null;
};

export type LatestReportedBundle = {
  readonly bundleId: string;
  readonly trackedInstallations: number;
  readonly observedShare: number;
  readonly bundle: AnalyticsBundleMetadata | null;
};

export type ConfiguredRollout = {
  readonly releaseId: string;
  readonly bundleId: string;
  readonly configuredPercentage: number;
  readonly trackedInstallations: number;
  readonly bundle: AnalyticsBundleMetadata;
};

export type AnalyticsOverview = {
  readonly trackedInstallations: number;
  readonly mostCommonLatestReportedBundle: LatestReportedBundle | null;
  readonly latestReportedBundles: readonly LatestReportedBundle[];
  readonly configuredRollouts: readonly ConfiguredRollout[];
};

export type LatestInstallationBundle = {
  readonly lastKnownBundleId: string | null;
};

export type InstallationBundleCount = {
  readonly bundleId: string;
  readonly installations: number;
};

const toBundleMetadata = (
  bundle: Bundle,
  release: ReleaseRow | undefined,
  channelById: ReadonlyMap<string, string>,
): AnalyticsBundleMetadata => ({
  platform: bundle.platform,
  channel: release ? (channelById.get(release.channel_id) ?? null) : null,
  targetAppVersion: release?.target_app_version ?? null,
  fingerprintHash: release?.fingerprint_hash ?? null,
});

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const createOverview = (
  bundles: readonly Bundle[],
  releases: readonly ReleaseRow[],
  channels: readonly ChannelRow[],
  trackedInstallations: number,
  latestReportedCounts: ReadonlyMap<string, number>,
): AnalyticsOverview => {
  const bundleById = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  const channelById = new Map(
    channels.map((channel) => [channel.id, channel.name]),
  );
  const bundleReleases = releases
    .filter(
      (release): release is ReleaseRow & { readonly bundle_id: string } =>
        release.kind === "BUNDLE" && release.bundle_id !== null,
    )
    .sort((left, right) => compareCodePoints(right.id, left.id));
  const latestReleaseByBundleId = new Map<string, ReleaseRow>();
  for (const release of bundleReleases) {
    if (!latestReleaseByBundleId.has(release.bundle_id)) {
      latestReleaseByBundleId.set(release.bundle_id, release);
    }
  }
  const latestReportedBundles = [...latestReportedCounts]
    .map(([bundleId, count]): LatestReportedBundle => {
      const bundle = bundleById.get(bundleId);
      return {
        bundleId,
        trackedInstallations: count,
        observedShare:
          trackedInstallations === 0 ? 0 : count / trackedInstallations,
        bundle: bundle
          ? toBundleMetadata(
              bundle,
              latestReleaseByBundleId.get(bundle.id),
              channelById,
            )
          : null,
      };
    })
    .sort(
      (left, right) =>
        right.trackedInstallations - left.trackedInstallations ||
        compareCodePoints(left.bundleId, right.bundleId),
    );
  const configuredRollouts = bundleReleases
    .filter((release) => bundleById.has(release.bundle_id))
    .map(
      (release): ConfiguredRollout => ({
        releaseId: release.id,
        bundleId: release.bundle_id,
        configuredPercentage:
          normalizeRolloutCohortCount(release.rollout_cohort_count) / 10,
        trackedInstallations: latestReportedCounts.get(release.bundle_id) ?? 0,
        bundle: toBundleMetadata(
          bundleById.get(release.bundle_id)!,
          release,
          channelById,
        ),
      }),
    )
    .sort((left, right) => compareCodePoints(left.releaseId, right.releaseId));

  return {
    trackedInstallations,
    mostCommonLatestReportedBundle: latestReportedBundles[0] ?? null,
    latestReportedBundles,
    configuredRollouts,
  };
};

const countLatestInstallationBundles = (
  rows: readonly LatestInstallationBundle[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.lastKnownBundleId === null) continue;
    counts.set(
      row.lastKnownBundleId,
      (counts.get(row.lastKnownBundleId) ?? 0) + 1,
    );
  }
  return counts;
};

export const createAnalyticsOverviewFromCounts = (
  bundles: readonly Bundle[],
  releases: readonly ReleaseRow[],
  channels: readonly ChannelRow[],
  trackedInstallations: number,
  counts: readonly InstallationBundleCount[],
): AnalyticsOverview =>
  createOverview(
    bundles,
    releases,
    channels,
    trackedInstallations,
    new Map(
      counts.map(({ bundleId, installations }) => [bundleId, installations]),
    ),
  );

export const createAnalyticsOverview = (
  bundles: readonly Bundle[],
  releases: readonly ReleaseRow[],
  channels: readonly ChannelRow[],
  latestInstallations: readonly LatestInstallationBundle[],
): AnalyticsOverview =>
  createOverview(
    bundles,
    releases,
    channels,
    latestInstallations.length,
    countLatestInstallationBundles(latestInstallations),
  );
