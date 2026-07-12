export class BlobDatabaseSnapshotError extends Error {
  readonly name = "BlobDatabaseSnapshotError";

  constructor(readonly source: string) {
    super(`Invalid blob database data at "${source}".`);
  }
}
