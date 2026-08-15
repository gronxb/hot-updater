/**
 * @deprecated Blob-backed database plugins will be removed in a future major
 * release. Use `createDatabasePlugin` with a row-oriented implementation.
 */
export class BlobDatabaseSnapshotError extends Error {
  readonly name = "BlobDatabaseSnapshotError";

  constructor(readonly source: string) {
    super(`Invalid blob database data at "${source}".`);
  }
}

export class BlobDatabaseUnknownFieldsError extends Error {
  readonly name = "BlobDatabaseUnknownFieldsError";

  constructor(
    readonly fields: readonly string[],
    source: "snapshot" | "revision pointer" = "snapshot",
  ) {
    super(
      `Blob database ${source} has unknown top-level fields: ${fields.join(", ")}`,
    );
  }
}
