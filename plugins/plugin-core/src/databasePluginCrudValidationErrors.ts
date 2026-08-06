export type DatabasePluginInputErrorCode =
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

export class DatabasePluginInputError extends Error {
  readonly name = "DatabasePluginInputError";

  constructor(readonly code: DatabasePluginInputErrorCode) {
    super(`Invalid database plugin input: ${code}`);
  }
}
