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
import type {
  BundleEventRow,
  BundlePatchRow,
  BundleRow,
  ChannelRow,
} from "./types";

export const BLOB_DATABASE_SNAPSHOT_KEY =
  "_hot-updater/database/v2.json" as const;
export const BLOB_DATABASE_BACKUP_KEY =
  "_hot-updater/database/v2.backup.json" as const;

export type BlobDatabaseSnapshot = {
  readonly version: 2;
  readonly bundles: readonly BundleRow[];
  readonly bundle_patches: readonly BundlePatchRow[];
  readonly channels: readonly ChannelRow[];
  readonly bundle_events: readonly BundleEventRow[];
};

export const emptyBlobDatabaseSnapshot = (): BlobDatabaseSnapshot => ({
  version: 2,
  bundles: [],
  bundle_patches: [],
  channels: [],
  bundle_events: [],
});

const parseBundleRow = (
  value: unknown,
  source: string,
  channelNameById: ReadonlyMap<string, string>,
  channelIdByName: ReadonlyMap<string, string>,
): BundleRow => {
  const input = blobRecord(value, source);
  const channelValue = blobProperty(input, "channel");
  const channelIdValue = blobProperty(input, "channel_id");
  const storedChannel =
    channelValue === undefined ? undefined : blobString(channelValue, source);
  const storedChannelId =
    channelIdValue === undefined
      ? undefined
      : blobString(channelIdValue, source);
  const channel =
    storedChannel ??
    channelNameById.get(blobString(channelIdValue, source)) ??
    blobString(channelIdValue, source);
  const channelId = storedChannelId ?? channelIdByName.get(channel) ?? channel;
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
    channel,
    channel_id: channelId,
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

const parseBundleEventRow = (
  value: unknown,
  source: string,
): BundleEventRow => {
  const input = blobRecord(value, source);
  const type = blobString(blobProperty(input, "type"), source);
  const updateStrategy = blobString(
    blobProperty(input, "update_strategy"),
    source,
  );
  if (type !== "UPDATE_APPLIED" && type !== "RECOVERED") {
    throw new BlobDatabaseSnapshotError(source);
  }
  if (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion") {
    throw new BlobDatabaseSnapshotError(source);
  }
  return {
    id: blobString(blobProperty(input, "id"), source),
    type,
    install_id: blobString(blobProperty(input, "install_id"), source),
    user_id: blobNullableString(blobProperty(input, "user_id"), source),
    username: blobNullableString(blobProperty(input, "username"), source),
    from_bundle_id: blobString(blobProperty(input, "from_bundle_id"), source),
    to_bundle_id: blobString(blobProperty(input, "to_bundle_id"), source),
    platform: blobPlatform(blobProperty(input, "platform"), source),
    app_version: blobString(blobProperty(input, "app_version"), source),
    channel: blobString(blobProperty(input, "channel"), source),
    cohort: blobString(blobProperty(input, "cohort"), source),
    update_strategy: updateStrategy,
    fingerprint_hash: blobNullableString(
      blobProperty(input, "fingerprint_hash"),
      source,
    ),
    sdk_version: blobNullableString(blobProperty(input, "sdk_version"), source),
    received_at_ms: blobNumber(blobProperty(input, "received_at_ms"), source),
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
  const channels = blobArray(blobProperty(input, "channels"), source).map(
    (row) => {
      const channel = blobRecord(row, source);
      const id = blobString(blobProperty(channel, "id"), source);
      const name = blobProperty(channel, "name");
      return {
        id,
        name: blobString(name === undefined ? id : name, source),
      };
    },
  );
  const channelNameById = new Map(
    channels.map(({ id, name }) => [id, name] as const),
  );
  const channelIdByName = new Map(
    channels.map(({ id, name }) => [name, id] as const),
  );
  const snapshot = normalizeBlobDatabaseSnapshot({
    version: 2,
    bundles: blobArray(blobProperty(input, "bundles"), source).map((row) =>
      parseBundleRow(row, source, channelNameById, channelIdByName),
    ),
    bundle_patches: blobArray(
      blobProperty(input, "bundle_patches"),
      source,
    ).map((row) => parsePatchRow(row, source)),
    channels,
    bundle_events: blobArray(
      blobProperty(input, "bundle_events") ?? [],
      source,
    ).map((row) => parseBundleEventRow(row, source)),
  });
  validateSnapshotRelations(snapshot, source);
  return snapshot;
};

const validateSnapshotRelations = (
  snapshot: BlobDatabaseSnapshot,
  source: string,
): void => {
  const channelNamesById = new Map(
    snapshot.channels.map(({ id, name }) => [id, name] as const),
  );
  const channelIds = new Set(channelNamesById.keys());
  const channelNames = new Set(snapshot.channels.map(({ name }) => name));
  const bundleIds = new Set(snapshot.bundles.map(({ id }) => id));
  const patchIds = new Set(snapshot.bundle_patches.map(({ id }) => id));
  const eventIds = new Set(snapshot.bundle_events.map(({ id }) => id));
  if (
    channelIds.size !== snapshot.channels.length ||
    channelNames.size !== snapshot.channels.length ||
    bundleIds.size !== snapshot.bundles.length ||
    patchIds.size !== snapshot.bundle_patches.length ||
    eventIds.size !== snapshot.bundle_events.length ||
    snapshot.bundles.some(
      ({ channel, channel_id }) =>
        !channelIds.has(channel_id) ||
        channelNamesById.get(channel_id) !== channel,
    ) ||
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
  bundle_events: [...snapshot.bundle_events].sort(
    (left, right) =>
      left.received_at_ms - right.received_at_ms ||
      left.id.localeCompare(right.id),
  ),
});
