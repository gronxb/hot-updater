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

export type AnalyticsOverviewAccumulator = {
  readonly addInstallationPage: (
    rows: readonly LatestInstallationBundle[],
  ) => void;
  readonly finish: () => AnalyticsOverview;
};

const toBundleMetadata = (bundle: Bundle): AnalyticsBundleMetadata => ({
  platform: bundle.platform,
  channel: bundle.channel,
  targetAppVersion: bundle.targetAppVersion,
  fingerprintHash: bundle.fingerprintHash,
});

export const createAnalyticsOverviewAccumulator = (
  bundles: readonly Bundle[],
): AnalyticsOverviewAccumulator => {
  const bundleById = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  const adoptionCounts = new Map<string, number>();
  let trackedInstallations = 0;

  return {
    addInstallationPage(rows) {
      for (const row of rows) {
        trackedInstallations += 1;
        adoptionCounts.set(
          row.lastKnownBundleId,
          (adoptionCounts.get(row.lastKnownBundleId) ?? 0) + 1,
        );
      }
    },
    finish() {
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
            left.bundleId.localeCompare(right.bundleId),
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
        .sort((left, right) => left.bundleId.localeCompare(right.bundleId));

      return {
        trackedInstallations,
        mostActiveBundle: adoption[0] ?? null,
        adoption,
        configuredRollouts,
      };
    },
  };
};

export const createAnalyticsOverview = (
  bundles: readonly Bundle[],
  latestInstallations: readonly LatestInstallationBundle[],
): AnalyticsOverview => {
  const accumulator = createAnalyticsOverviewAccumulator(bundles);
  accumulator.addInstallationPage(latestInstallations);
  return accumulator.finish();
};
