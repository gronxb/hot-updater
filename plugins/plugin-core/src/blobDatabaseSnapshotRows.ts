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
import type { BundlePatchRow, BundleRow } from "./types";

const bundleFields = new Set([
  "id",
  "platform",
  "should_force_update",
  "enabled",
  "file_hash",
  "git_commit_hash",
  "message",
  "channel",
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
const patchFields = new Set([
  "id",
  "bundle_id",
  "base_bundle_id",
  "base_file_hash",
  "patch_file_hash",
  "patch_storage_uri",
  "order_index",
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
  row: BundlePatchRow | BundleRow,
): readonly string[] => rowUnknownFields.get(row) ?? [];

export const parseBundleRow = (value: unknown, source: string): BundleRow => {
  const input = blobRecord(value, source);
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
    channel: blobString(blobProperty(input, "channel"), source),
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
