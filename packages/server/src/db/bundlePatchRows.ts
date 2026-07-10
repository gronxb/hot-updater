import type { Bundle, BundlePatchArtifact } from "@hot-updater/core";
import { getDatabaseBundlePatchId } from "@hot-updater/plugin-core";
import type {
  DatabaseBundlePatch,
  DatabaseBundlePatchUpdate,
} from "@hot-updater/plugin-core";
import { toDatabaseBundlePatches } from "@hot-updater/plugin-core";

export interface BundlePatchRow {
  readonly id: string;
  readonly bundle_id: string;
  readonly base_bundle_id: string;
  readonly base_file_hash: string;
  readonly patch_file_hash: string;
  readonly patch_storage_uri: string;
  readonly order_index: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toExpectedPatchId = (
  patch: Pick<DatabaseBundlePatch, "bundleId" | "baseBundleId">,
): string => getDatabaseBundlePatchId(patch.bundleId, patch.baseBundleId);

const toPatchRowId = (patch: DatabaseBundlePatch): string => {
  const expectedId = toExpectedPatchId(patch);
  if (patch.id !== undefined && patch.id !== expectedId) {
    throw new Error(
      `Invalid bundle patch id. Expected '${expectedId}' for bundle '${patch.bundleId}'.`,
    );
  }
  return expectedId;
};

export const isBundlePatchRow = (value: unknown): value is BundlePatchRow =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.bundle_id === "string" &&
  typeof value.base_bundle_id === "string" &&
  typeof value.base_file_hash === "string" &&
  typeof value.patch_file_hash === "string" &&
  typeof value.patch_storage_uri === "string" &&
  typeof value.order_index === "number";

export const parseBundlePatchRow = (value: unknown): BundlePatchRow => {
  if (isBundlePatchRow(value)) {
    return value;
  }
  throw new Error("Invalid bundle patch row.");
};

export const parseBundlePatchRows = (
  values: readonly unknown[],
): BundlePatchRow[] => values.map(parseBundlePatchRow);

export const databaseBundlePatchToRow = (
  patch: DatabaseBundlePatch,
): BundlePatchRow => ({
  id: toPatchRowId(patch),
  bundle_id: patch.bundleId,
  base_bundle_id: patch.baseBundleId,
  base_file_hash: patch.baseFileHash,
  patch_file_hash: patch.patchFileHash,
  patch_storage_uri: patch.patchStorageUri,
  order_index: patch.orderIndex,
});

export const databaseBundlePatchUpdateToRow = (
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

export const bundleToPatchRows = (bundle: Bundle): BundlePatchRow[] =>
  toDatabaseBundlePatches(bundle).map(databaseBundlePatchToRow);

export const rowToDatabaseBundlePatch = (
  record: BundlePatchRow,
): DatabaseBundlePatch => {
  const patch = {
    id: record.id,
    bundleId: record.bundle_id,
    baseBundleId: record.base_bundle_id,
    baseFileHash: record.base_file_hash,
    patchFileHash: record.patch_file_hash,
    patchStorageUri: record.patch_storage_uri,
    orderIndex: record.order_index,
  };
  return {
    ...patch,
    id: toPatchRowId(patch),
  };
};

export const bundlePatchRowToPatchArtifact = (
  record: BundlePatchRow,
): BundlePatchArtifact => ({
  baseBundleId: record.base_bundle_id,
  baseFileHash: record.base_file_hash,
  patchFileHash: record.patch_file_hash,
  patchStorageUri: record.patch_storage_uri,
});
