import { BlobDatabaseSnapshotError } from "./blobDatabaseErrors";
import {
  blobArray,
  blobBoolean,
  blobNullableString,
  blobNumber,
  blobPlatform,
  blobProperty,
  blobRecord,
  blobString,
  blobStringArray,
} from "./blobDatabaseValue";
import type { BundlePatchRow, BundleRow, ChannelRow } from "./types";

export const BLOB_DATABASE_SNAPSHOT_KEY =
  "_hot-updater/database/v2.json" as const;
export const BLOB_DATABASE_BACKUP_KEY =
  "_hot-updater/database/v2.backup.json" as const;

export type BlobDatabaseSnapshot = {
  readonly version: 2;
  readonly bundles: readonly BundleRow[];
  readonly bundle_patches: readonly BundlePatchRow[];
  readonly channels: readonly ChannelRow[];
};

export const emptyBlobDatabaseSnapshot = (): BlobDatabaseSnapshot => ({
  version: 2,
  bundles: [],
  bundle_patches: [],
  channels: [],
});

const parseBundleRow = (value: unknown, source: string): BundleRow => {
  const input = blobRecord(value, source);
  const channelId = blobProperty(input, "channel_id");
  return {
    id: blobString(blobProperty(input, "id"), source),
    platform: blobPlatform(blobProperty(input, "platform"), source),
    should_force_update: blobBoolean(
      blobProperty(input, "should_force_update"),
      source,
    ),
    enabled: blobBoolean(blobProperty(input, "enabled"), source),
    file_hash: blobString(blobProperty(input, "file_hash"), source),
    git_commit_hash: blobNullableString(
      blobProperty(input, "git_commit_hash"),
      source,
    ),
    message: blobNullableString(blobProperty(input, "message"), source),
    channel_id: blobString(
      channelId === undefined ? blobProperty(input, "channel") : channelId,
      source,
    ),
    storage_uri: blobString(blobProperty(input, "storage_uri"), source),
    target_app_version: blobNullableString(
      blobProperty(input, "target_app_version"),
      source,
    ),
    fingerprint_hash: blobNullableString(
      blobProperty(input, "fingerprint_hash"),
      source,
    ),
    metadata: blobProperty(input, "metadata"),
    rollout_cohort_count: blobNumber(
      blobProperty(input, "rollout_cohort_count"),
      source,
    ),
    target_cohorts: blobStringArray(
      blobProperty(input, "target_cohorts"),
      source,
    ),
    manifest_storage_uri: blobNullableString(
      blobProperty(input, "manifest_storage_uri"),
      source,
    ),
    manifest_file_hash: blobNullableString(
      blobProperty(input, "manifest_file_hash"),
      source,
    ),
    asset_base_storage_uri: blobNullableString(
      blobProperty(input, "asset_base_storage_uri"),
      source,
    ),
  };
};

const parsePatchRow = (value: unknown, source: string): BundlePatchRow => {
  const input = blobRecord(value, source);
  return {
    id: blobString(blobProperty(input, "id"), source),
    bundle_id: blobString(blobProperty(input, "bundle_id"), source),
    base_bundle_id: blobString(blobProperty(input, "base_bundle_id"), source),
    base_file_hash: blobString(blobProperty(input, "base_file_hash"), source),
    patch_file_hash: blobString(blobProperty(input, "patch_file_hash"), source),
    patch_storage_uri: blobString(
      blobProperty(input, "patch_storage_uri"),
      source,
    ),
    order_index: blobNumber(blobProperty(input, "order_index"), source),
  };
};

export const parseBlobDatabaseSnapshot = (
  value: unknown,
  source: string = BLOB_DATABASE_SNAPSHOT_KEY,
): BlobDatabaseSnapshot => {
  const input = blobRecord(value, source);
  if (blobProperty(input, "version") !== 2) {
    throw new BlobDatabaseSnapshotError(source);
  }
  const snapshot = normalizeBlobDatabaseSnapshot({
    version: 2,
    bundles: blobArray(blobProperty(input, "bundles"), source).map((row) =>
      parseBundleRow(row, source),
    ),
    bundle_patches: blobArray(
      blobProperty(input, "bundle_patches"),
      source,
    ).map((row) => parsePatchRow(row, source)),
    channels: blobArray(blobProperty(input, "channels"), source).map((row) => {
      const channel = blobRecord(row, source);
      const id = blobString(blobProperty(channel, "id"), source);
      const name = blobProperty(channel, "name");
      return {
        id,
        name: blobString(name === undefined ? id : name, source),
      };
    }),
  });
  validateSnapshotRelations(snapshot, source);
  return snapshot;
};

const validateSnapshotRelations = (
  snapshot: BlobDatabaseSnapshot,
  source: string,
): void => {
  const channelIds = new Set(snapshot.channels.map(({ id }) => id));
  const channelNames = new Set(snapshot.channels.map(({ name }) => name));
  const bundleIds = new Set(snapshot.bundles.map(({ id }) => id));
  const patchIds = new Set(snapshot.bundle_patches.map(({ id }) => id));
  if (
    channelIds.size !== snapshot.channels.length ||
    channelNames.size !== snapshot.channels.length ||
    bundleIds.size !== snapshot.bundles.length ||
    patchIds.size !== snapshot.bundle_patches.length ||
    snapshot.bundles.some(({ channel_id }) => !channelIds.has(channel_id)) ||
    snapshot.bundle_patches.some(
      ({ base_bundle_id, bundle_id }) =>
        !bundleIds.has(bundle_id) || !bundleIds.has(base_bundle_id),
    )
  ) {
    throw new BlobDatabaseSnapshotError(source);
  }
};

export const normalizeBlobDatabaseSnapshot = (
  snapshot: BlobDatabaseSnapshot,
): BlobDatabaseSnapshot => ({
  version: 2,
  bundles: [...snapshot.bundles].sort((left, right) =>
    left.id.localeCompare(right.id),
  ),
  bundle_patches: [...snapshot.bundle_patches].sort(
    (left, right) =>
      left.bundle_id.localeCompare(right.bundle_id) ||
      left.order_index - right.order_index ||
      left.id.localeCompare(right.id),
  ),
  channels: [...snapshot.channels].sort((left, right) =>
    left.id.localeCompare(right.id),
  ),
});
