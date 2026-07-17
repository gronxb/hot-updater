import { BlobDatabaseSnapshotError } from "./blobDatabaseErrors";
import {
  parseBundleEventRow,
  parseBundleRow,
  parsePatchRow,
} from "./blobDatabaseSnapshotRows";
import {
  blobArray,
  blobProperty,
  blobRecord,
  blobString,
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
