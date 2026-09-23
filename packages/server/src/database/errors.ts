export type ConstraintReason =
  | "exists"
  | "unique"
  | "not_found"
  | "referenced"
  | "too_large";

export class DatabaseConstraintError extends Error {
  readonly name = "DatabaseConstraintError";
  constructor(
    readonly reason: ConstraintReason,
    readonly model: string,
  ) {
    super(`${model}: ${reason}`);
  }
}

/** The retry budget ran out; ingestion answers 503 with Retry-After. */
export class DatabaseConflictError extends Error {
  readonly name = "DatabaseConflictError";
}

/** The write may or may not have committed; it is reported, never rerun. */
export class DatabaseAmbiguousCommitError extends Error {
  readonly name = "DatabaseAmbiguousCommitError";
}

export class DatabaseTransactionError extends Error {
  readonly name = "DatabaseTransactionError";
}
