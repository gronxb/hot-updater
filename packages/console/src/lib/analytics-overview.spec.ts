import type { Bundle, ReleaseRow } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { createAnalyticsOverview } from "./analytics-overview";

const createBundle = (overrides: Partial<Bundle>): Bundle => ({
  id: "bundle-a",
  platform: "ios",
  fileHash: "hash",
  storageUri: "storage://bundle.zip",
  archiveByteSize: 3_000_000_001,
  gitCommitHash: null,
  ...overrides,
});

const bundles = [
  createBundle({ id: "bundle-a" }),
  createBundle({
    id: "bundle-b",
    platform: "android",
  }),
  createBundle({ id: "bundle-c" }),
  createBundle({
    id: "bundle-zero",
    platform: "android",
  }),
] as const;

const createRelease = (
  bundle: Bundle,
  overrides: Partial<ReleaseRow> = {},
): ReleaseRow => ({
  id: `release-${bundle.id.slice("bundle-".length)}`,
  revision: 1,
  scope_key: `scope-${bundle.id}`,
  channel_id: "channel-production",
  platform: bundle.platform,
  kind: "BUNDLE",
  bundle_id: bundle.id,
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
  created_at_ms: 1,
  updated_at_ms: 1,
  ...overrides,
});

const releases = [
  createRelease(bundles[0]),
  createRelease(bundles[1], {
    strategy: "FINGERPRINT",
    target_app_version: null,
    fingerprint_hash: "fp-b",
    rollout_cohort_count: 250,
  }),
  createRelease(bundles[2], {
    channel_id: "channel-beta",
    target_app_version: "1.1.0",
  }),
  createRelease(bundles[3], {
    channel_id: "channel-beta",
    target_app_version: "2.0.0",
    rollout_cohort_count: 0,
  }),
] as const;

const channels = [
  { id: "channel-production", name: "production" },
  { id: "channel-beta", name: "beta" },
] as const;

describe("createAnalyticsOverview", () => {
  it("aggregates one latest row per tracked installation without leaking identity", () => {
    // Given
    const latestRows = [
      { installId: "install-1", lastKnownBundleId: "bundle-a" },
      { installId: "install-2", lastKnownBundleId: "bundle-a" },
      { installId: "install-3", lastKnownBundleId: "bundle-b" },
      { installId: "install-4", lastKnownBundleId: "deleted-bundle" },
    ] as const;

    // When
    const overview = createAnalyticsOverview(
      bundles,
      releases,
      channels,
      latestRows,
    );

    // Then
    expect(overview.trackedInstallations).toBe(4);
    expect(overview.latestReportedBundles).toMatchObject([
      {
        bundleId: "bundle-a",
        trackedInstallations: 2,
        observedShare: 0.5,
      },
      {
        bundleId: "bundle-b",
        trackedInstallations: 1,
        observedShare: 0.25,
      },
      {
        bundleId: "deleted-bundle",
        trackedInstallations: 1,
        observedShare: 0.25,
        bundle: null,
      },
    ]);
    expect(overview.mostCommonLatestReportedBundle?.bundleId).toBe("bundle-a");
    expect(JSON.stringify(overview)).not.toMatch(
      /installId|username|userId|current|live|completion|recovered/i,
    );
  });

  it("sorts equal latest-reported counts by bundle id for every input order", () => {
    // Given
    const rows = [
      { installId: "install-1", lastKnownBundleId: "bundle-b" },
      { installId: "install-2", lastKnownBundleId: "deleted-bundle" },
      { installId: "install-3", lastKnownBundleId: "bundle-a" },
    ] as const;

    // When
    const forward = createAnalyticsOverview(bundles, releases, channels, rows);
    const reverse = createAnalyticsOverview(
      bundles,
      releases,
      channels,
      [...rows].reverse(),
    );

    // Then
    expect(
      forward.latestReportedBundles.map(({ bundleId }) => bundleId),
    ).toEqual(["bundle-a", "bundle-b", "deleted-bundle"]);
    expect(reverse.mostCommonLatestReportedBundle?.bundleId).toBe("bundle-a");
  });

  it("retains configured rollout rows when no installations are tracked", () => {
    // Given
    const originalBundles = structuredClone(bundles);
    const latestRows: readonly [] = [];

    // When
    const overview = createAnalyticsOverview(
      bundles,
      releases,
      channels,
      latestRows,
    );

    // Then
    expect(overview).toMatchObject({
      trackedInstallations: 0,
      mostCommonLatestReportedBundle: null,
      latestReportedBundles: [],
    });
    expect(
      overview.configuredRollouts.map(
        ({ bundleId, configuredPercentage, trackedInstallations }) => ({
          bundleId,
          configuredPercentage,
          trackedInstallations,
        }),
      ),
    ).toEqual([
      {
        bundleId: "bundle-a",
        configuredPercentage: 100,
        trackedInstallations: 0,
      },
      {
        bundleId: "bundle-b",
        configuredPercentage: 25,
        trackedInstallations: 0,
      },
      {
        bundleId: "bundle-c",
        configuredPercentage: 100,
        trackedInstallations: 0,
      },
      {
        bundleId: "bundle-zero",
        configuredPercentage: 0,
        trackedInstallations: 0,
      },
    ]);
    expect(bundles).toEqual(originalBundles);
  });
});
