import {
  BlobDatabaseSnapshotError,
  BlobDatabaseUnknownFieldsError,
} from "./blobDatabaseErrors";
import {
  getBlobDatabaseRowUnknownFields,
  parseBundleRow,
  parsePatchRow,
} from "./blobDatabaseSnapshotRows";
import { blobArray, blobProperty, blobRecord } from "./blobDatabaseValue";
import type { BundlePatchRow, BundleRow } from "./types";

export const BLOB_DATABASE_SNAPSHOT_KEY =
  "_hot-updater/database/v2.json" as const;
export const BLOB_DATABASE_BACKUP_KEY =
  "_hot-updater/database/v2.backup.json" as const;

export type BlobDatabaseSnapshot = {
  readonly version: 2;
  readonly bundles: readonly BundleRow[];
  readonly bundle_patches: readonly BundlePatchRow[];
};

const snapshotUnknownFields = new WeakMap<
  BlobDatabaseSnapshot,
  readonly string[]
>();
const snapshotFields = new Set(["version", "bundles", "bundle_patches"]);

export const emptyBlobDatabaseSnapshot = (): BlobDatabaseSnapshot => ({
  version: 2,
  bundles: [],
  bundle_patches: [],
});

export const assertBlobDatabaseSnapshotCompatible = (
  snapshot: BlobDatabaseSnapshot,
): void => {
  const fields = snapshotUnknownFields.get(snapshot);
  if (fields && fields.length > 0) {
    throw new BlobDatabaseUnknownFieldsError(fields);
  }
};

export const parseBlobDatabaseSnapshot = (
  value: unknown,
  source: string = BLOB_DATABASE_SNAPSHOT_KEY,
): BlobDatabaseSnapshot => {
  const input = blobRecord(value, source);
  if (blobProperty(input, "version") !== 2) {
    throw new BlobDatabaseSnapshotError(source);
  }
  const snapshot = normalizeBlobDatabaseSnapshot({
    version: 2,
    bundles: blobArray(blobProperty(input, "bundles"), source).map((row) =>
      parseBundleRow(row, source),
    ),
    bundle_patches: blobArray(
      blobProperty(input, "bundle_patches"),
      source,
    ).map((row) => parsePatchRow(row, source)),
  });
  const unknownFields = [
    ...Object.keys(input).filter((key) => !snapshotFields.has(key)),
    ...snapshot.bundles.flatMap((row, index) =>
      getBlobDatabaseRowUnknownFields(row).map(
        (field) => `bundles[${index}].${field}`,
      ),
    ),
    ...snapshot.bundle_patches.flatMap((row, index) =>
      getBlobDatabaseRowUnknownFields(row).map(
        (field) => `bundle_patches[${index}].${field}`,
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (unknownFields.length > 0) {
    snapshotUnknownFields.set(snapshot, unknownFields);
  }
  validateSnapshotRelations(snapshot, source);
  return snapshot;
};

const validateSnapshotRelations = (
  snapshot: BlobDatabaseSnapshot,
  source: string,
): void => {
  const bundleIds = new Set(snapshot.bundles.map(({ id }) => id));
  const patchIds = new Set(snapshot.bundle_patches.map(({ id }) => id));
  if (
    bundleIds.size !== snapshot.bundles.length ||
    patchIds.size !== snapshot.bundle_patches.length ||
    snapshot.bundle_patches.some(
      ({ base_bundle_id, bundle_id }) =>
        !bundleIds.has(bundle_id) || !bundleIds.has(base_bundle_id),
    )
  ) {
    throw new BlobDatabaseSnapshotError(source);
  }
};

export const normalizeBlobDatabaseSnapshot = (
  snapshot: BlobDatabaseSnapshot,
): BlobDatabaseSnapshot => ({
  version: 2,
  bundles: [...snapshot.bundles].sort((left, right) =>
    left.id.localeCompare(right.id),
  ),
  bundle_patches: [...snapshot.bundle_patches].sort(
    (left, right) =>
      left.bundle_id.localeCompare(right.bundle_id) ||
      left.order_index - right.order_index ||
      left.id.localeCompare(right.id),
  ),
});
