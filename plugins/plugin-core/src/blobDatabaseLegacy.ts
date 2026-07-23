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
import type { BundlePatchRow, BundleRow } from "./types";

const parseLegacyPatch = (
  value: object,
  bundleId: string,
  orderIndex: number,
  source: string,
): BundlePatchRow => {
  const baseBundleId = blobString(blobProperty(value, "baseBundleId"), source);
  return {
    id: `${bundleId}:${baseBundleId}`,
    bundle_id: bundleId,
    base_bundle_id: baseBundleId,
    base_file_hash: blobString(blobProperty(value, "baseFileHash"), source),
    patch_file_hash: blobString(blobProperty(value, "patchFileHash"), source),
    patch_storage_uri: blobString(
      blobProperty(value, "patchStorageUri"),
      source,
    ),
    order_index: orderIndex,
  };
};

const legacyScalarPatch = (
  input: object,
  bundleId: string,
  source: string,
): readonly BundlePatchRow[] => {
  const baseBundleId = blobProperty(input, "patchBaseBundleId");
  if (baseBundleId === null || baseBundleId === undefined) return [];
  return [
    parseLegacyPatch(
      {
        baseBundleId,
        baseFileHash: blobProperty(input, "patchBaseFileHash"),
        patchFileHash: blobProperty(input, "patchFileHash"),
        patchStorageUri: blobProperty(input, "patchStorageUri"),
      },
      bundleId,
      0,
      source,
    ),
  ];
};

export const parseLegacyBundle = (
  value: unknown,
  source: string,
): {
  readonly bundle: BundleRow;
  readonly channelName: string;
  readonly patches: readonly BundlePatchRow[];
} => {
  const input = blobRecord(value, source);
  const id = blobString(blobProperty(input, "id"), source);
  const channelName = blobString(blobProperty(input, "channel"), source);
  const bundle: BundleRow = {
    id,
    platform: blobPlatform(blobProperty(input, "platform"), source),
    should_force_update: blobBoolean(
      blobProperty(input, "shouldForceUpdate"),
      source,
    ),
    enabled: blobBoolean(blobProperty(input, "enabled"), source),
    file_hash: blobString(blobProperty(input, "fileHash"), source),
    git_commit_hash: blobNullableString(
      blobProperty(input, "gitCommitHash"),
      source,
    ),
    message: blobNullableString(blobProperty(input, "message"), source),
    channel: channelName,
    storage_uri: blobString(blobProperty(input, "storageUri"), source),
    target_app_version: blobNullableString(
      blobProperty(input, "targetAppVersion"),
      source,
    ),
    fingerprint_hash: blobNullableString(
      blobProperty(input, "fingerprintHash"),
      source,
    ),
    metadata: blobProperty(input, "metadata") ?? {},
    rollout_cohort_count:
      blobProperty(input, "rolloutCohortCount") === undefined
        ? 1000
        : blobNumber(blobProperty(input, "rolloutCohortCount"), source),
    target_cohorts: blobStringArray(
      blobProperty(input, "targetCohorts"),
      source,
    ),
    manifest_storage_uri: blobNullableString(
      blobProperty(input, "manifestStorageUri"),
      source,
    ),
    manifest_file_hash: blobNullableString(
      blobProperty(input, "manifestFileHash"),
      source,
    ),
    asset_base_storage_uri: blobNullableString(
      blobProperty(input, "assetBaseStorageUri"),
      source,
    ),
  };
  const patchesValue = blobProperty(input, "patches");
  const patches = Array.isArray(patchesValue)
    ? patchesValue.map((patch, index) =>
        parseLegacyPatch(blobRecord(patch, source), id, index, source),
      )
    : legacyScalarPatch(input, id, source);
  return { bundle, channelName, patches };
};
