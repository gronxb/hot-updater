import type { Bundle } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { createAnalyticsOverview } from "./analytics-overview";

const createBundle = (overrides: Partial<Bundle>): Bundle => ({
  id: "bundle-a",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "hash",
  storageUri: "storage://bundle.zip",
  gitCommitHash: null,
  message: null,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  ...overrides,
});

const bundles = [
  createBundle({ id: "bundle-a", rolloutCohortCount: 1000 }),
  createBundle({
    id: "bundle-b",
    platform: "android",
    targetAppVersion: null,
    fingerprintHash: "fp-b",
    rolloutCohortCount: 250,
  }),
  createBundle({
    id: "bundle-c",
    channel: "beta",
    targetAppVersion: "1.1.0",
    rolloutCohortCount: null,
  }),
  createBundle({
    id: "bundle-zero",
    channel: "beta",
    platform: "android",
    targetAppVersion: "2.0.0",
    rolloutCohortCount: 0,
  }),
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
    const overview = createAnalyticsOverview(bundles, latestRows);

    // Then
    expect(overview.trackedInstallations).toBe(4);
    expect(overview.adoption).toMatchObject([
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
    expect(overview.mostActiveBundle?.bundleId).toBe("bundle-a");
    expect(JSON.stringify(overview)).not.toMatch(
      /installId|username|userId|current|live|completion|recovered/i,
    );
  });

  it("sorts equal adoption counts by bundle id for every input order", () => {
    // Given
    const rows = [
      { installId: "install-1", lastKnownBundleId: "bundle-b" },
      { installId: "install-2", lastKnownBundleId: "deleted-bundle" },
      { installId: "install-3", lastKnownBundleId: "bundle-a" },
    ] as const;

    // When
    const forward = createAnalyticsOverview(bundles, rows);
    const reverse = createAnalyticsOverview(bundles, [...rows].reverse());

    // Then
    expect(forward.adoption.map(({ bundleId }) => bundleId)).toEqual([
      "bundle-a",
      "bundle-b",
      "deleted-bundle",
    ]);
    expect(reverse.mostActiveBundle?.bundleId).toBe("bundle-a");
  });

  it("retains configured rollout rows when no installations are tracked", () => {
    // Given
    const originalBundles = structuredClone(bundles);
    const latestRows: readonly [] = [];

    // When
    const overview = createAnalyticsOverview(bundles, latestRows);

    // Then
    expect(overview).toMatchObject({
      trackedInstallations: 0,
      mostActiveBundle: null,
      adoption: [],
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
