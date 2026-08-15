import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import {
  isRecord,
  modelValidators,
  validateFields,
} from "./databasePluginCrudValidationFields";
import { databaseFields } from "./types/databaseFields";
import type {
  DatabaseImplementationResult,
  DatabaseModel,
  SelectedDatabaseInputRow,
} from "./types/internal";

export const validateCreateData = (
  model: DatabaseModel,
  data: unknown,
): void => {
  if (!isRecord(data)) throw new DatabasePluginInputError("invalid-data");
  validateFields(model, Object.keys(data));
  for (const field of databaseFields[model]) {
    const validator = modelValidators[model][field];
    if (
      !Object.hasOwn(data, field) ||
      !validator ||
      !validator(Reflect.get(data, field))
    ) {
      throw new DatabasePluginInputError("invalid-data");
    }
  }
  if (
    model === "bundles" &&
    data.target_app_version === null &&
    data.fingerprint_hash === null
  ) {
    throw new DatabasePluginInputError("invalid-data");
  }
};

export const selectRow = <
  TInput extends {
    readonly model: DatabaseModel;
    readonly select?: readonly string[] | undefined;
  },
>(
  row: DatabaseImplementationResult,
  input: TInput,
): SelectedDatabaseInputRow<TInput> => {
  const { select } = input;
  if (!select) return row as SelectedDatabaseInputRow<TInput>;
  return Object.fromEntries(
    select.map((field) => [field, Reflect.get(row, field)]),
  ) as SelectedDatabaseInputRow<TInput>;
};

export const validateResult = (
  model: DatabaseModel,
  row: DatabaseImplementationResult,
  select: readonly string[] | undefined,
): void => {
  if (!isRecord(row)) throw new DatabasePluginInputError("invalid-result");
  const fields = select ?? databaseFields[model];
  for (const field of fields) {
    const validator = modelValidators[model][field];
    if (
      !Object.hasOwn(row, field) ||
      !validator ||
      !validator(Reflect.get(row, field))
    ) {
      throw new DatabasePluginInputError("invalid-result");
    }
  }
  if (
    model === "bundles" &&
    Object.hasOwn(row, "target_app_version") &&
    Object.hasOwn(row, "fingerprint_hash") &&
    Reflect.get(row, "target_app_version") === null &&
    Reflect.get(row, "fingerprint_hash") === null
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
};
