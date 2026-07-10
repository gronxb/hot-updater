import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getAssetBaseStorageUri,
  getManifestFileHash,
  getManifestStorageUri,
  stripBundleArtifactMetadata,
  type Bundle,
} from "@hot-updater/core";
import { toDatabaseBundlePatches } from "@hot-updater/plugin-core";

import type { SupabaseBundlePatchRow, SupabaseBundleRow } from "./types";

export const BUNDLE_SELECT_COLUMNS =
  "id, channel, enabled, platform, should_force_update, file_hash, git_commit_hash, message, fingerprint_hash, target_app_version, storage_uri, metadata, manifest_storage_uri, manifest_file_hash, asset_base_storage_uri, rollout_cohort_count, target_cohorts";

const normalizeMetadata = (value: unknown): Bundle["metadata"] => {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return normalizeMetadata(parsed);
    } catch {
      return {};
    }
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  return {};
};

export const mapRowToBundle = (
  row: SupabaseBundleRow,
  patchRows: SupabaseBundlePatchRow[] = [],
): Bundle => {
  const rawMetadata = normalizeMetadata(row.metadata);
  const patches = patchRows
    .slice()
    .sort(
      (left, right) =>
        left.order_index - right.order_index ||
        left.base_bundle_id.localeCompare(right.base_bundle_id),
    )
    .map((patch) => ({
      baseBundleId: patch.base_bundle_id,
      baseFileHash: patch.base_file_hash,
      patchFileHash: patch.patch_file_hash,
      patchStorageUri: patch.patch_storage_uri,
    }));
  const primaryPatch = patches[0] ?? null;

  return {
    channel: row.channel,
    enabled: Boolean(row.enabled),
    shouldForceUpdate: Boolean(row.should_force_update),
    fileHash: row.file_hash,
    gitCommitHash: row.git_commit_hash,
    id: row.id,
    message: row.message,
    platform: row.platform,
    targetAppVersion: row.target_app_version,
    fingerprintHash: row.fingerprint_hash,
    storageUri: row.storage_uri,
    metadata: stripBundleArtifactMetadata(rawMetadata),
    manifestStorageUri: row.manifest_storage_uri ?? null,
    manifestFileHash: row.manifest_file_hash ?? null,
    assetBaseStorageUri: row.asset_base_storage_uri ?? null,
    patches,
    patchBaseBundleId: primaryPatch?.baseBundleId ?? null,
    patchBaseFileHash: primaryPatch?.baseFileHash ?? null,
    patchFileHash: primaryPatch?.patchFileHash ?? null,
    patchStorageUri: primaryPatch?.patchStorageUri ?? null,
    rolloutCohortCount:
      row.rollout_cohort_count ?? DEFAULT_ROLLOUT_COHORT_COUNT,
    targetCohorts: row.target_cohorts ?? null,
  };
};

export const bundleToRow = (bundle: Bundle): SupabaseBundleRow => ({
  id: bundle.id,
  channel: bundle.channel,
  enabled: bundle.enabled,
  should_force_update: bundle.shouldForceUpdate,
  file_hash: bundle.fileHash,
  git_commit_hash: bundle.gitCommitHash,
  message: bundle.message,
  platform: bundle.platform,
  target_app_version: bundle.targetAppVersion,
  fingerprint_hash: bundle.fingerprintHash,
  storage_uri: bundle.storageUri,
  metadata: stripBundleArtifactMetadata(bundle.metadata) ?? {},
  manifest_storage_uri: getManifestStorageUri(bundle),
  manifest_file_hash: getManifestFileHash(bundle),
  asset_base_storage_uri: getAssetBaseStorageUri(bundle),
  rollout_cohort_count:
    bundle.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
  target_cohorts: bundle.targetCohorts ?? null,
});

export const bundleToPatchRows = (bundle: Bundle): SupabaseBundlePatchRow[] =>
  toDatabaseBundlePatches(bundle).map((patch) => ({
    id: patch.id ?? `${patch.bundleId}:${patch.baseBundleId}`,
    bundle_id: patch.bundleId,
    base_bundle_id: patch.baseBundleId,
    base_file_hash: patch.baseFileHash,
    patch_file_hash: patch.patchFileHash,
    patch_storage_uri: patch.patchStorageUri,
    order_index: patch.orderIndex,
  }));
