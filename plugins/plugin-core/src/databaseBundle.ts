import type { Bundle, BundlePatchArtifact } from "@hot-updater/core";
import { getBundlePatches } from "@hot-updater/core";

import type { DatabaseBundlePatch, DatabaseBundleRecord } from "./types";

export const getDatabaseBundlePatchId = (
  bundleId: string,
  baseBundleId: string,
) => `${bundleId}:${baseBundleId}`;

export const toDatabaseBundleRecord = (
  bundle: Bundle,
): DatabaseBundleRecord => {
  const {
    patches: _patches,
    patchBaseBundleId: _patchBaseBundleId,
    patchBaseFileHash: _patchBaseFileHash,
    patchFileHash: _patchFileHash,
    patchStorageUri: _patchStorageUri,
    ...record
  } = bundle;

  return record;
};

export const toDatabaseBundlePatches = (
  bundle: Bundle,
): DatabaseBundlePatch[] =>
  getBundlePatches(bundle).map((patch, index) => ({
    id: getDatabaseBundlePatchId(bundle.id, patch.baseBundleId),
    bundleId: bundle.id,
    baseBundleId: patch.baseBundleId,
    baseFileHash: patch.baseFileHash,
    patchFileHash: patch.patchFileHash,
    patchStorageUri: patch.patchStorageUri,
    orderIndex: index,
  }));

export const splitDatabaseBundle = (
  bundle: Bundle,
): {
  readonly bundle: DatabaseBundleRecord;
  readonly patches: readonly DatabaseBundlePatch[];
} => ({
  bundle: toDatabaseBundleRecord(bundle),
  patches: toDatabaseBundlePatches(bundle),
});

const toBundlePatchArtifact = (
  patch: DatabaseBundlePatch,
): BundlePatchArtifact => ({
  baseBundleId: patch.baseBundleId,
  baseFileHash: patch.baseFileHash,
  patchFileHash: patch.patchFileHash,
  patchStorageUri: patch.patchStorageUri,
});

export const toBundleReadModel = (
  record: DatabaseBundleRecord,
  patches: readonly DatabaseBundlePatch[] = [],
): Bundle => {
  const sortedPatches = patches
    .slice()
    .sort(
      (left, right) =>
        left.orderIndex - right.orderIndex ||
        left.baseBundleId.localeCompare(right.baseBundleId),
    )
    .map(toBundlePatchArtifact);
  const primaryPatch = sortedPatches[0] ?? null;

  return {
    ...record,
    patches: sortedPatches,
    patchBaseBundleId: primaryPatch?.baseBundleId ?? null,
    patchBaseFileHash: primaryPatch?.baseFileHash ?? null,
    patchFileHash: primaryPatch?.patchFileHash ?? null,
    patchStorageUri: primaryPatch?.patchStorageUri ?? null,
  };
};
