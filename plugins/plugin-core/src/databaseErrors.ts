/** A bundle an operation names is not stored. */
export class DatabaseBundleNotFoundError extends Error {
  readonly name = "DatabaseBundleNotFoundError";

  constructor(readonly bundleId: string) {
    super(`Bundle "${bundleId}" was not found.`);
  }
}

/** A row a delete names is still referenced, such as a bundle a release uses. */
export class DatabaseRowReferencedError extends Error {
  readonly name = "DatabaseRowReferencedError";

  constructor() {
    super("The database row is still referenced.");
  }
}

export type DatabasePluginInputErrorCode =
  | "invalid-data"
  | "invalid-field"
  | "invalid-pagination"
  | "invalid-query"
  | "invalid-result";

/** Input a database operation refuses before touching storage. */
export class DatabasePluginInputError extends Error {
  readonly name = "DatabasePluginInputError";

  constructor(readonly code: DatabasePluginInputErrorCode) {
    super(`Invalid database plugin input: ${code}`);
  }
}
