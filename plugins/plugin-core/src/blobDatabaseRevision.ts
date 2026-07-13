import { BlobDatabaseSnapshotError } from "./blobDatabaseErrors";
import {
  BLOB_DATABASE_SNAPSHOT_KEY,
  type BlobDatabaseSnapshot,
  parseBlobDatabaseSnapshot,
} from "./blobDatabaseSnapshot";
import { blobProperty, blobRecord, blobString } from "./blobDatabaseValue";

const REVISION_ROOT = "_hot-updater/database/revisions";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BlobDatabasePointer = {
  readonly version: 2;
  readonly active_revision: string;
};

export const createBlobDatabasePointer = (
  revision: string,
): BlobDatabasePointer => ({ version: 2, active_revision: revision });

export const isBlobDatabasePointer = (
  value: unknown,
): value is BlobDatabasePointer => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Reflect.has(value, "active_revision");
};

export const parseBlobDatabasePointer = (
  value: unknown,
  source: string = BLOB_DATABASE_SNAPSHOT_KEY,
): BlobDatabasePointer => {
  const input = blobRecord(value, source);
  const revision = blobString(blobProperty(input, "active_revision"), source);
  if (blobProperty(input, "version") !== 2 || !UUID_PATTERN.test(revision)) {
    throw new BlobDatabaseSnapshotError(source);
  }
  return createBlobDatabasePointer(revision);
};

export const blobDatabaseRevisionSnapshotKey = (revision: string): string =>
  `${REVISION_ROOT}/${revision}/snapshot.json`;

export const blobDatabaseRevisionManifestPrefix = (revision: string): string =>
  `${REVISION_ROOT}/${revision}/manifests`;

export const readBlobDatabaseRoot = (
  value: unknown,
):
  | { readonly kind: "pointer"; readonly pointer: BlobDatabasePointer }
  | { readonly kind: "snapshot"; readonly snapshot: BlobDatabaseSnapshot } =>
  isBlobDatabasePointer(value)
    ? { kind: "pointer", pointer: parseBlobDatabasePointer(value) }
    : { kind: "snapshot", snapshot: parseBlobDatabaseSnapshot(value) };
