import type { Bundle } from "@hot-updater/core";
import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  ClientAccessKeyRow,
} from "@hot-updater/plugin-core";

const fixtureId = (suffix: string): string =>
  `00000000-0000-0000-0000-${suffix.padStart(12, "0")}`;

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
  channel_id: createChannelRowFixture(channel).id,
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

export const createBundleEventRowFixture = (
  suffix: string,
  receivedAtMs: number,
): BundleEventRow => ({
  id: fixtureId(suffix),
  type: "UPDATE_APPLIED",
  install_id: `install-${suffix}`,
  user_id: null,
  username: null,
  from_bundle_id: fixtureId(`${Number(suffix) + 1000}`),
  to_bundle_id: fixtureId(`${Number(suffix) + 2000}`),
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "0",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

export const createClientAccessKeyRowFixture = (
  suffix: string,
  createdAtMs: number,
): ClientAccessKeyRow => ({
  id: `client-key-${suffix}`,
  hash: `hash-${suffix}`,
  name: `Client ${suffix}`,
  prefix: suffix.padStart(6, "0").slice(0, 6),
  role: "client",
  created_at_ms: createdAtMs,
  revoked_at_ms: null,
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
