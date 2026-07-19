export type DatabaseAdapterInputErrorCode =
  | "empty-mutation-where"
  | "empty-select"
  | "invalid-data"
  | "invalid-distinct"
  | "invalid-field"
  | "invalid-model"
  | "invalid-operation"
  | "invalid-query"
  | "invalid-result"
  | "invalid-pagination"
  | "invalid-update-selector";

export class DatabaseAdapterInputError extends Error {
  readonly name = "DatabaseAdapterInputError";

  constructor(readonly code: DatabaseAdapterInputErrorCode) {
    super(`Invalid database adapter input: ${code}`);
  }
}
