import type { Bundle } from "@hot-updater/core";
import type { BundlePatchRow, BundleRow } from "@hot-updater/plugin-core";

const fixtureId = (suffix: string): string =>
  `00000000-0000-0000-0000-${suffix.padStart(12, "0")}`;

export const createBundleRowFixture = (
  suffix: string,
  channel = "production",
): BundleRow => ({
  id: fixtureId(suffix),
  platform: "ios",
  should_force_update: false,
  enabled: true,
  file_hash: `hash-${suffix}`,
  git_commit_hash: null,
  message: `bundle-${suffix}`,
  channel,
  storage_uri: `storage://bundles/${suffix}.zip`,
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  metadata: { app_version: suffix },
  rollout_cohort_count: 1000,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

export const createBundlePatchRowFixture = (
  suffix: string,
  bundleId: string,
  baseBundleId: string,
  orderIndex = 0,
): BundlePatchRow => ({
  id: `patch-${suffix}`,
  bundle_id: bundleId,
  base_bundle_id: baseBundleId,
  base_file_hash: `base-hash-${suffix}`,
  patch_file_hash: `patch-hash-${suffix}`,
  patch_storage_uri: `storage://patches/${suffix}.patch`,
  order_index: orderIndex,
});

export const createBundleFixture = (
  suffix: string,
  channel = "production",
): Bundle => ({
  id: fixtureId(suffix),
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: `hash-${suffix}`,
  gitCommitHash: null,
  message: `bundle-${suffix}`,
  channel,
  storageUri: `storage://bundles/${suffix}.zip`,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  metadata: { app_version: suffix },
});
