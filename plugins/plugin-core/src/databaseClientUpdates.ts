import type { Bundle } from "@hot-updater/core";
import { getBundlePatches } from "@hot-updater/core";

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
  _channelId?: string,
): BundleRowUpdate => {
  const fields = {
    ...(update.platform !== undefined ? { platform: update.platform } : {}),
    ...(update.fileHash !== undefined ? { file_hash: update.fileHash } : {}),
    ...(update.gitCommitHash !== undefined
      ? { git_commit_hash: update.gitCommitHash }
      : {}),
    ...(update.storageUri !== undefined
      ? { storage_uri: update.storageUri }
      : {}),
    ...(update.metadata !== undefined
      ? { metadata: bundleMetadataToRow(update.metadata) }
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
  return fields;
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
