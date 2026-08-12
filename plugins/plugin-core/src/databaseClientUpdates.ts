import type { Bundle } from "@hot-updater/core";
import {
  DEFAULT_ROLLOUT_COHORT_COUNT,
  getBundlePatches,
} from "@hot-updater/core";

import { bundleMetadataToRow } from "./databaseMetadata";
import type { BundlePatchRow, BundleRowUpdate } from "./types";

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

export const bundleUpdateToRow = (
  update: Partial<Bundle>,
  channelId?: string,
): BundleRowUpdate => {
  const fields = {
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
      ? { metadata: bundleMetadataToRow(update.metadata) }
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
  };
  return update.channel === undefined
    ? fields
    : { ...fields, channel: update.channel, channel_id: channelId! };
};

export const bundleUpdateToPatchRows = (
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
