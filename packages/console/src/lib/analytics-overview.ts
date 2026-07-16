import { normalizeRolloutCohortCount } from "@hot-updater/core";
import type { Bundle } from "@hot-updater/plugin-core";

export type AnalyticsBundleMetadata = {
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly targetAppVersion: string | null;
  readonly fingerprintHash: string | null;
};

export type BundleAdoption = {
  readonly bundleId: string;
  readonly trackedInstallations: number;
  readonly observedShare: number;
  readonly bundle: AnalyticsBundleMetadata | null;
};

export type ConfiguredRollout = {
  readonly bundleId: string;
  readonly configuredPercentage: number;
  readonly trackedInstallations: number;
  readonly bundle: AnalyticsBundleMetadata;
};

export type AnalyticsOverview = {
  readonly trackedInstallations: number;
  readonly mostActiveBundle: BundleAdoption | null;
  readonly adoption: readonly BundleAdoption[];
  readonly configuredRollouts: readonly ConfiguredRollout[];
};

export type LatestInstallationBundle = {
  readonly lastKnownBundleId: string;
};

export type InstallationBundleCount = {
  readonly bundleId: string;
  readonly installations: number;
};

const toBundleMetadata = (bundle: Bundle): AnalyticsBundleMetadata => ({
  platform: bundle.platform,
  channel: bundle.channel,
  targetAppVersion: bundle.targetAppVersion,
  fingerprintHash: bundle.fingerprintHash,
});

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const createOverview = (
  bundles: readonly Bundle[],
  trackedInstallations: number,
  adoptionCounts: ReadonlyMap<string, number>,
): AnalyticsOverview => {
  const bundleById = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  const adoption = [...adoptionCounts]
    .map(([bundleId, count]): BundleAdoption => {
      const bundle = bundleById.get(bundleId);
      return {
        bundleId,
        trackedInstallations: count,
        observedShare:
          trackedInstallations === 0 ? 0 : count / trackedInstallations,
        bundle: bundle ? toBundleMetadata(bundle) : null,
      };
    })
    .sort(
      (left, right) =>
        right.trackedInstallations - left.trackedInstallations ||
        compareCodePoints(left.bundleId, right.bundleId),
    );
  const configuredRollouts = bundles
    .map(
      (bundle): ConfiguredRollout => ({
        bundleId: bundle.id,
        configuredPercentage:
          normalizeRolloutCohortCount(bundle.rolloutCohortCount) / 10,
        trackedInstallations: adoptionCounts.get(bundle.id) ?? 0,
        bundle: toBundleMetadata(bundle),
      }),
    )
    .sort((left, right) => compareCodePoints(left.bundleId, right.bundleId));

  return {
    trackedInstallations,
    mostActiveBundle: adoption[0] ?? null,
    adoption,
    configuredRollouts,
  };
};

const countLatestInstallationBundles = (
  rows: readonly LatestInstallationBundle[],
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(
      row.lastKnownBundleId,
      (counts.get(row.lastKnownBundleId) ?? 0) + 1,
    );
  }
  return counts;
};

export const createAnalyticsOverviewFromCounts = (
  bundles: readonly Bundle[],
  trackedInstallations: number,
  counts: readonly InstallationBundleCount[],
): AnalyticsOverview =>
  createOverview(
    bundles,
    trackedInstallations,
    new Map(
      counts.map(({ bundleId, installations }) => [bundleId, installations]),
    ),
  );

export const createAnalyticsOverview = (
  bundles: readonly Bundle[],
  latestInstallations: readonly LatestInstallationBundle[],
): AnalyticsOverview =>
  createOverview(
    bundles,
    latestInstallations.length,
    countLatestInstallationBundles(latestInstallations),
  );
