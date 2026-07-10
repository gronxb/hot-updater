import { getPatchId, materializePatch } from "./databaseRuntimePatches";
import type { DatabaseBundlePatch, DatabaseBundlePatchUpdate } from "./types";

export interface BundlePatchRow {
  readonly id: string;
  readonly bundle_id: string;
  readonly base_bundle_id: string;
  readonly base_file_hash: string;
  readonly patch_file_hash: string;
  readonly patch_storage_uri: string;
  readonly order_index: number;
}

export const toPatch = (row: BundlePatchRow): DatabaseBundlePatch =>
  materializePatch({
    id: row.id,
    bundleId: row.bundle_id,
    baseBundleId: row.base_bundle_id,
    baseFileHash: row.base_file_hash,
    patchFileHash: row.patch_file_hash,
    patchStorageUri: row.patch_storage_uri,
    orderIndex: row.order_index,
  });

export const toRow = (patch: DatabaseBundlePatch): BundlePatchRow => {
  const nextPatch = materializePatch(patch);
  return {
    id: getPatchId(nextPatch),
    bundle_id: nextPatch.bundleId,
    base_bundle_id: nextPatch.baseBundleId,
    base_file_hash: nextPatch.baseFileHash,
    patch_file_hash: nextPatch.patchFileHash,
    patch_storage_uri: nextPatch.patchStorageUri,
    order_index: nextPatch.orderIndex,
  };
};

export const toUpdateRow = (
  patch: DatabaseBundlePatchUpdate,
): Partial<BundlePatchRow> => ({
  ...(patch.baseFileHash !== undefined
    ? { base_file_hash: patch.baseFileHash }
    : {}),
  ...(patch.patchFileHash !== undefined
    ? { patch_file_hash: patch.patchFileHash }
    : {}),
  ...(patch.patchStorageUri !== undefined
    ? { patch_storage_uri: patch.patchStorageUri }
    : {}),
  ...(patch.orderIndex !== undefined ? { order_index: patch.orderIndex } : {}),
});
