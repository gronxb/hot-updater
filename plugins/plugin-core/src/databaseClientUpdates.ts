import type { Bundle } from "@hot-updater/core";
import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getBundlePatches,
  stripBundleArtifactMetadata,
} from "@hot-updater/core";

import type {
  BundlePatchRow,
  BundleRowUpdate,
  TransactionDatabasePlugin,
} from "./types";

export class DatabasePatchUpdateUnsupportedError extends Error {
  readonly name = "DatabasePatchUpdateUnsupportedError";

  constructor(
    readonly bundleId: string,
    readonly pluginName: string,
  ) {
    super(
      `Database plugin "${pluginName}" cannot atomically replace patches for bundle "${bundleId}".`,
    );
  }
}

const bundleUpdateToRow = (update: Partial<Bundle>): BundleRowUpdate => ({
  ...(update.platform !== undefined ? { platform: update.platform } : {}),
  ...(update.shouldForceUpdate !== undefined
    ? { should_force_update: update.shouldForceUpdate }
    : {}),
  ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
  ...(update.fileHash !== undefined ? { file_hash: update.fileHash } : {}),
  ...(update.gitCommitHash !== undefined
    ? { git_commit_hash: update.gitCommitHash }
    : {}),
  ...(update.message !== undefined ? { message: update.message } : {}),
  ...(update.channel !== undefined ? { channel: update.channel } : {}),
  ...(update.storageUri !== undefined
    ? { storage_uri: update.storageUri }
    : {}),
  ...(update.targetAppVersion !== undefined
    ? { target_app_version: update.targetAppVersion }
    : {}),
  ...(update.fingerprintHash !== undefined
    ? { fingerprint_hash: update.fingerprintHash }
    : {}),
  ...(update.metadata !== undefined
    ? { metadata: stripBundleArtifactMetadata(update.metadata) ?? {} }
    : {}),
  ...(update.rolloutCohortCount !== undefined
    ? {
        rollout_cohort_count:
          update.rolloutCohortCount ?? DEFAULT_ROLLOUT_COHORT_COUNT,
      }
    : {}),
  ...(update.targetCohorts !== undefined
    ? { target_cohorts: update.targetCohorts }
    : {}),
  ...(update.manifestStorageUri !== undefined
    ? { manifest_storage_uri: update.manifestStorageUri }
    : {}),
  ...(update.manifestFileHash !== undefined
    ? { manifest_file_hash: update.manifestFileHash }
    : {}),
  ...(update.assetBaseStorageUri !== undefined
    ? { asset_base_storage_uri: update.assetBaseStorageUri }
    : {}),
});

const bundleUpdateToPatchRows = (
  bundleId: string,
  update: Partial<Bundle>,
): BundlePatchRow[] =>
  getBundlePatches({ patches: update.patches }).map((patch, orderIndex) => ({
    id: `${bundleId}:${patch.baseBundleId}`,
    bundle_id: bundleId,
    base_bundle_id: patch.baseBundleId,
    base_file_hash: patch.baseFileHash,
    patch_file_hash: patch.patchFileHash,
    patch_storage_uri: patch.patchStorageUri,
    order_index: orderIndex,
  }));

export const updateBundle = async (
  database: TransactionDatabasePlugin,
  bundleId: string,
  update: Partial<Bundle>,
): Promise<boolean> => {
  const rowUpdate = bundleUpdateToRow(update);
  const patchesPresent = Object.hasOwn(update, "patches");
  const updated =
    Object.keys(rowUpdate).length > 0
      ? await database.update({
          model: "bundles",
          where: [{ field: "id", value: bundleId }],
          update: rowUpdate,
          select: ["id"],
        })
      : await database.findOne({
          model: "bundles",
          where: [{ field: "id", value: bundleId }],
          select: ["id"],
        });
  if (!updated) return false;
  if (!patchesPresent) return true;

  await database.delete({
    model: "bundle_patches",
    where: [{ field: "bundle_id", value: bundleId }],
  });
  for (const patch of bundleUpdateToPatchRows(bundleId, update)) {
    await database.create({ model: "bundle_patches", data: patch });
  }
  return true;
};
