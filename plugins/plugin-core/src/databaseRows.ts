import type { Bundle, BundlePatchArtifact, Release } from "@hot-updater/core";
import {
  getAssetBaseStorageUri,
  getBundlePatches,
  getManifestFileHash,
  getManifestStorageUri,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";

import { bundleMetadataToRow } from "./databaseMetadata";
import type { BundlePatchRow, BundleRow, ReleaseRow } from "./types";

export const releaseToRow = (
  release: Release,
  scopeKey: string,
): ReleaseRow => ({
  id: release.id,
  revision: release.revision,
  scope_key: scopeKey,
  channel_id: release.channelId,
  platform: release.platform,
  kind: release.kind,
  bundle_id: release.bundleId,
  strategy: release.strategy,
  target_app_version: release.targetAppVersion,
  fingerprint_hash: release.fingerprintHash,
  enabled: release.enabled,
  should_force_update: release.shouldForceUpdate,
  message: release.message,
  rollout_cohort_count: release.rolloutCohortCount,
  target_cohorts: release.targetCohorts,
  operation: release.operation,
  source_release_id: release.sourceReleaseId,
  created_at_ms: release.createdAtMs,
  updated_at_ms: release.updatedAtMs,
});

export const releaseRowToRelease = (row: ReleaseRow): Release => ({
  id: row.id,
  revision: row.revision,
  channelId: row.channel_id,
  platform: row.platform,
  kind: row.kind,
  bundleId: row.bundle_id,
  strategy: row.strategy,
  targetAppVersion: row.target_app_version,
  fingerprintHash: row.fingerprint_hash,
  enabled: row.enabled,
  shouldForceUpdate: row.should_force_update,
  message: row.message,
  rolloutCohortCount: row.rollout_cohort_count,
  targetCohorts: row.target_cohorts,
  operation: row.operation,
  sourceReleaseId: row.source_release_id,
  createdAtMs: row.created_at_ms,
  updatedAtMs: row.updated_at_ms,
});

export const BundleRowHydrationErrorReason = {
  duplicatePatchId: "duplicate_patch_id",
  orphanPatchOwner: "orphan_patch_owner",
  orphanPatchBase: "orphan_patch_base",
} as const;

export type BundleRowHydrationErrorReason =
  (typeof BundleRowHydrationErrorReason)[keyof typeof BundleRowHydrationErrorReason];

type BundleRowHydrationErrorInput = {
  readonly reason: BundleRowHydrationErrorReason;
  readonly patchId: string;
  readonly bundleId: string;
};

export class BundleRowHydrationError extends Error {
  readonly name = "BundleRowHydrationError";
  readonly reason: BundleRowHydrationErrorReason;
  readonly patchId: string;
  readonly bundleId: string;

  constructor({ reason, patchId, bundleId }: BundleRowHydrationErrorInput) {
    super(
      `Cannot hydrate bundle rows: ${reason} for patch "${patchId}" and bundle "${bundleId}".`,
    );
    this.reason = reason;
    this.patchId = patchId;
    this.bundleId = bundleId;
  }
}

export const bundleToRow = (bundle: Bundle, _channelId?: string): BundleRow => {
  const metadata = bundleMetadataToRow(bundle.metadata);
  return {
    id: bundle.id,
    platform: bundle.platform,
    file_hash: bundle.fileHash,
    git_commit_hash: bundle.gitCommitHash,
    storage_uri: bundle.storageUri,
    metadata,
    manifest_storage_uri: getManifestStorageUri(bundle),
    manifest_file_hash: getManifestFileHash(bundle),
    asset_base_storage_uri: getAssetBaseStorageUri(bundle),
  };
};

export const bundleToPatchRows = (bundle: Bundle): BundlePatchRow[] =>
  getBundlePatches(bundle).map((patch, orderIndex) => ({
    id: `${bundle.id}:${patch.baseBundleId}`,
    bundle_id: bundle.id,
    base_bundle_id: patch.baseBundleId,
    base_file_hash: patch.baseFileHash,
    patch_file_hash: patch.patchFileHash,
    patch_storage_uri: patch.patchStorageUri,
    order_index: orderIndex,
  }));

const comparePatchRows = (left: BundlePatchRow, right: BundlePatchRow) =>
  left.order_index - right.order_index || left.id.localeCompare(right.id);

const patchRowToArtifact = (row: BundlePatchRow): BundlePatchArtifact => ({
  baseBundleId: row.base_bundle_id,
  baseFileHash: row.base_file_hash,
  patchFileHash: row.patch_file_hash,
  patchStorageUri: row.patch_storage_uri,
});

export const rowToBundle = (
  row: BundleRow,
  patchRows: readonly BundlePatchRow[] = [],
): Bundle => {
  const patches = patchRows
    .slice()
    .sort(comparePatchRows)
    .map(patchRowToArtifact);
  const primaryPatch = patches[0] ?? null;
  return {
    id: row.id,
    platform: row.platform,
    fileHash: row.file_hash,
    gitCommitHash: row.git_commit_hash,
    storageUri: row.storage_uri,
    metadata: stripBundleArtifactMetadata(row.metadata),
    manifestStorageUri: row.manifest_storage_uri,
    manifestFileHash: row.manifest_file_hash,
    assetBaseStorageUri: row.asset_base_storage_uri,
    patches,
    patchBaseBundleId: primaryPatch?.baseBundleId ?? null,
    patchBaseFileHash: primaryPatch?.baseFileHash ?? null,
    patchFileHash: primaryPatch?.patchFileHash ?? null,
    patchStorageUri: primaryPatch?.patchStorageUri ?? null,
  };
};

export const rowsToBundles = (
  bundleRows: readonly BundleRow[],
  patchRows: readonly BundlePatchRow[],
  referencedBundleRows: readonly BundleRow[],
): Bundle[] => {
  const ownerIds = new Set(bundleRows.map(({ id }) => id));
  const baseIds = new Set(ownerIds);
  for (const row of referencedBundleRows) baseIds.add(row.id);

  const patchIds = new Set<string>();
  const patchesByOwner = new Map<string, BundlePatchRow[]>();
  for (const patch of patchRows) {
    if (patchIds.has(patch.id)) {
      throw new BundleRowHydrationError({
        reason: BundleRowHydrationErrorReason.duplicatePatchId,
        patchId: patch.id,
        bundleId: patch.bundle_id,
      });
    }
    patchIds.add(patch.id);
    if (!ownerIds.has(patch.bundle_id)) {
      throw new BundleRowHydrationError({
        reason: BundleRowHydrationErrorReason.orphanPatchOwner,
        patchId: patch.id,
        bundleId: patch.bundle_id,
      });
    }
    if (!baseIds.has(patch.base_bundle_id)) {
      throw new BundleRowHydrationError({
        reason: BundleRowHydrationErrorReason.orphanPatchBase,
        patchId: patch.id,
        bundleId: patch.base_bundle_id,
      });
    }
    const ownerPatches = patchesByOwner.get(patch.bundle_id) ?? [];
    ownerPatches.push(patch);
    patchesByOwner.set(patch.bundle_id, ownerPatches);
  }

  return bundleRows.map((row) =>
    rowToBundle(row, patchesByOwner.get(row.id) ?? []),
  );
};
