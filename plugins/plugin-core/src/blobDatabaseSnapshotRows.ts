import { BlobDatabaseSnapshotError } from "./blobDatabaseErrors";
import {
  blobBoolean,
  blobMetadataObject,
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
  ClientAccessKeyRow,
} from "./types";

const bundleFields = new Set([
  "id",
  "platform",
  "should_force_update",
  "enabled",
  "file_hash",
  "git_commit_hash",
  "message",
  "channel",
  "channel_id",
  "storage_uri",
  "target_app_version",
  "fingerprint_hash",
  "metadata",
  "rollout_cohort_count",
  "target_cohorts",
  "manifest_storage_uri",
  "manifest_file_hash",
  "asset_base_storage_uri",
]);
const channelFields = new Set(["id", "name"]);
const patchFields = new Set([
  "id",
  "bundle_id",
  "base_bundle_id",
  "base_file_hash",
  "patch_file_hash",
  "patch_storage_uri",
  "order_index",
]);
const eventFields = new Set([
  "id",
  "type",
  "install_id",
  "user_id",
  "username",
  "from_bundle_id",
  "to_bundle_id",
  "platform",
  "app_version",
  "channel",
  "cohort",
  "update_strategy",
  "fingerprint_hash",
  "sdk_version",
  "received_at_ms",
]);
const clientAccessKeyFields = new Set([
  "id",
  "hash",
  "name",
  "prefix",
  "role",
  "created_at_ms",
  "revoked_at_ms",
]);
const rowUnknownFields = new WeakMap<object, readonly string[]>();

const trackUnknownFields = <TRow extends object>(
  row: TRow,
  input: object,
  fields: ReadonlySet<string>,
): TRow => {
  const unknownFields = Object.keys(input)
    .filter((key) => !fields.has(key))
    .sort((left, right) => left.localeCompare(right));
  if (unknownFields.length > 0) rowUnknownFields.set(row, unknownFields);
  return row;
};

export const getBlobDatabaseRowUnknownFields = (
  row:
    | BundleEventRow
    | BundlePatchRow
    | BundleRow
    | ChannelRow
    | ClientAccessKeyRow,
): readonly string[] => rowUnknownFields.get(row) ?? [];

export const blobDatabaseBackfillChannelId = (name: string): string =>
  `legacy-channel:${encodeURIComponent(name)}`;

export const parseBundleRow = (
  value: unknown,
  source: string,
  resolveLegacyChannelId: (
    name: string,
  ) => string = blobDatabaseBackfillChannelId,
): BundleRow => {
  const input = blobRecord(value, source);
  const channel = blobString(blobProperty(input, "channel"), source);
  const channelId = blobProperty(input, "channel_id");
  const row: BundleRow = {
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
    channel_id:
      channelId === undefined
        ? resolveLegacyChannelId(channel)
        : blobString(channelId, source),
    storage_uri: blobString(blobProperty(input, "storage_uri"), source),
    target_app_version: blobNullableString(
      blobProperty(input, "target_app_version"),
      source,
    ),
    fingerprint_hash: blobNullableString(
      blobProperty(input, "fingerprint_hash"),
      source,
    ),
    metadata: blobMetadataObject(blobProperty(input, "metadata"), source),
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
  return trackUnknownFields(row, input, bundleFields);
};

export const parseChannelRow = (value: unknown, source: string): ChannelRow => {
  const input = blobRecord(value, source);
  const row: ChannelRow = {
    id: blobString(blobProperty(input, "id"), source),
    name: blobString(blobProperty(input, "name"), source),
  };
  return trackUnknownFields(row, input, channelFields);
};

export const parsePatchRow = (
  value: unknown,
  source: string,
): BundlePatchRow => {
  const input = blobRecord(value, source);
  const row: BundlePatchRow = {
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
  return trackUnknownFields(row, input, patchFields);
};

export const parseBundleEventRow = (
  value: unknown,
  source: string,
): BundleEventRow => {
  const input = blobRecord(value, source);
  const type = blobString(blobProperty(input, "type"), source);
  const fromBundleId = blobNullableString(
    blobProperty(input, "from_bundle_id"),
    source,
  );
  const updateStrategy = blobNullableString(
    blobProperty(input, "update_strategy"),
    source,
  );
  if (
    !(
      ((type === "UPDATE_APPLIED" || type === "RECOVERED") &&
        fromBundleId !== null &&
        (updateStrategy === "fingerprint" ||
          updateStrategy === "appVersion")) ||
      (type === "UNCHANGED" && fromBundleId === null && updateStrategy === null)
    )
  ) {
    throw new BlobDatabaseSnapshotError(source);
  }
  const row = {
    id: blobString(blobProperty(input, "id"), source),
    type,
    install_id: blobString(blobProperty(input, "install_id"), source),
    user_id: blobNullableString(blobProperty(input, "user_id"), source),
    username: blobNullableString(blobProperty(input, "username"), source),
    from_bundle_id: fromBundleId,
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
  } as BundleEventRow;
  return trackUnknownFields(row, input, eventFields);
};

export const parseClientAccessKeyRow = (
  value: unknown,
  source: string,
): ClientAccessKeyRow => {
  const input = blobRecord(value, source);
  const role = blobString(blobProperty(input, "role"), source);
  if (role !== "client") throw new BlobDatabaseSnapshotError(source);
  const revokedAt = blobProperty(input, "revoked_at_ms");
  const row: ClientAccessKeyRow = {
    id: blobString(blobProperty(input, "id"), source),
    hash: blobString(blobProperty(input, "hash"), source),
    name: blobString(blobProperty(input, "name"), source),
    prefix: blobString(blobProperty(input, "prefix"), source),
    role,
    created_at_ms: blobNumber(blobProperty(input, "created_at_ms"), source),
    revoked_at_ms: revokedAt === null ? null : blobNumber(revokedAt, source),
  };
  return trackUnknownFields(row, input, clientAccessKeyFields);
};
