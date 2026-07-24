import { BlobDatabaseSnapshotError } from "./blobDatabaseErrors";
import {
  blobBoolean,
  blobNullableString,
  blobNumber,
  blobPlatform,
  blobProperty,
  blobRecord,
  blobString,
  blobStringArray,
} from "./blobDatabaseValue";
import type { BundlePatchRow, BundleRow, DatabaseRow } from "./types";

type BundleEventPersistenceRow = DatabaseRow<"bundle_events">;

export const parseBundleRow = (value: unknown, source: string): BundleRow => {
  const input = blobRecord(value, source);
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

export const parsePatchRow = (
  value: unknown,
  source: string,
): BundlePatchRow => {
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

export const parseBundleEventRow = (
  value: unknown,
  source: string,
): BundleEventPersistenceRow => {
  const input = blobRecord(value, source);
  const type = blobString(blobProperty(input, "type"), source);
  const fromBundleValue = blobProperty(input, "from_bundle_id");
  const updateStrategyValue = blobProperty(input, "update_strategy");
  if (fromBundleValue === undefined || updateStrategyValue === undefined) {
    throw new BlobDatabaseSnapshotError(source);
  }
  const fromBundleId = blobNullableString(fromBundleValue, source);
  const updateStrategy = blobNullableString(updateStrategyValue, source);
  const common = {
    id: blobString(blobProperty(input, "id"), source),
    install_id: blobString(blobProperty(input, "install_id"), source),
    user_id: blobNullableString(blobProperty(input, "user_id"), source),
    username: blobNullableString(blobProperty(input, "username"), source),
    to_bundle_id: blobString(blobProperty(input, "to_bundle_id"), source),
    platform: blobPlatform(blobProperty(input, "platform"), source),
    app_version: blobString(blobProperty(input, "app_version"), source),
    channel: blobString(blobProperty(input, "channel"), source),
    cohort: blobString(blobProperty(input, "cohort"), source),
    fingerprint_hash: blobNullableString(
      blobProperty(input, "fingerprint_hash"),
      source,
    ),
    sdk_version: blobNullableString(blobProperty(input, "sdk_version"), source),
    received_at_ms: blobNumber(blobProperty(input, "received_at_ms"), source),
  };

  switch (type) {
    case "UNCHANGED":
      if (fromBundleId !== null || updateStrategy !== null) {
        throw new BlobDatabaseSnapshotError(source);
      }
      return {
        ...common,
        type: "UNCHANGED",
        from_bundle_id: null,
        update_strategy: null,
      };
    case "UPDATE_APPLIED":
      if (
        fromBundleId === null ||
        (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion")
      ) {
        throw new BlobDatabaseSnapshotError(source);
      }
      return {
        ...common,
        type: "UPDATE_APPLIED",
        from_bundle_id: fromBundleId,
        update_strategy: updateStrategy,
      };
    case "RECOVERED":
      if (
        fromBundleId === null ||
        (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion")
      ) {
        throw new BlobDatabaseSnapshotError(source);
      }
      return {
        ...common,
        type: "RECOVERED",
        from_bundle_id: fromBundleId,
        update_strategy: updateStrategy,
      };
    default:
      throw new BlobDatabaseSnapshotError(source);
  }
};
