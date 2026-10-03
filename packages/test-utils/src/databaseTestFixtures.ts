import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { getSha256 } from "@hot-updater/plugin-core";
import type { Bundle } from "@hot-updater/protocol";

const fixtureId = (suffix: string): string =>
  `00000000-0000-7000-8000-${suffix.padStart(12, "0")}`;

export const fixtureManifestAssets = {
  "index.ios.bundle": {
    fileHash: "c".repeat(64),
    downloadFileHash: "a".repeat(64),
    downloadByteSize: 1_000,
    downloadCompression: "br" as const,
  },
};

export const createManifestFixture = (suffix: string, archive?: object) =>
  JSON.stringify({
    bundleId: fixtureId(suffix),
    patchAssetPath: "index.ios.bundle",
    assets: fixtureManifestAssets,
    ...(archive ? { archive } : {}),
  });

const channelFixtureSuffix = (name: string): string => {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.codePointAt(0)!) % 1_000_000_000_000;
  }
  return String(hash);
};

export const createChannelRowFixture = (name = "production"): ChannelRow => ({
  id: fixtureId(channelFixtureSuffix(name)),
  name,
});

export const createBundleRowFixture = (
  suffix: string,
  _channel = "production",
): BundleRow => ({
  id: fixtureId(suffix),
  platform: "ios",
  git_commit_hash: null,
  metadata: { app_version: suffix },
  manifest_storage_uri: `storage://bundles/${suffix}/manifest.json`,
  manifest_file_hash: getSha256(createManifestFixture(suffix)),
  asset_base_storage_uri: "storage://assets",
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
  byte_size: 3_000_000_002,
  order_index: orderIndex,
});

export const createReleaseRowFixture = (
  suffix: string,
  bundle: BundleRow,
  channel: ChannelRow,
): ReleaseRow => ({
  id: fixtureId(`${Number(suffix) + 5000}`),
  scope_key: `v1:app-version:ios:${channel.name}`,
  channel_id: channel.id,
  platform: bundle.platform,
  kind: "BUNDLE",
  bundle_id: bundle.id,
  strategy: "APP_VERSION",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  enabled: true,
  should_force_update: false,
  message: `release-${suffix}`,
  rollout_cohort_count: 1000,
  target_cohorts: [],
  operation: "DEPLOY",
  source_release_id: null,
  revision: 1,
  created_at_ms: Number(suffix),
  updated_at_ms: Number(suffix),
});

export const createBundleFixture = (
  suffix: string,
  _channel = "production",
): Bundle => ({
  id: fixtureId(suffix),
  platform: "ios",
  gitCommitHash: null,
  metadata: { app_version: suffix },
  manifestStorageUri: `storage://bundles/${suffix}/manifest.json`,
  manifestFileHash: getSha256(createManifestFixture(suffix)),
  assetBaseStorageUri: "storage://assets",
});
