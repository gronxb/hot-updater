import { DatabasePluginInputError } from "./databasePluginCrudValidationErrors";
import {
  isRecord,
  modelValidators,
  validateFields,
} from "./databasePluginCrudValidationFields";
import type {
  DatabaseImplementationResult,
  DatabaseModel,
  DatabaseSelect,
  SelectedDatabaseRow,
} from "./types";
import { databaseFields } from "./types/databaseFields";

export const isBundleEventProjectionShape = (
  data: Readonly<Record<string, unknown>>,
): boolean => {
  if (!Object.hasOwn(data, "type")) return true;
  const type = data.type;
  if (
    type !== "UPDATE_APPLIED" &&
    type !== "RECOVERED" &&
    type !== "UNCHANGED"
  ) {
    return false;
  }
  if (Object.hasOwn(data, "from_bundle_id")) {
    const fromBundleId = data.from_bundle_id;
    if (type === "UNCHANGED" && fromBundleId !== null) return false;
    if (type !== "UNCHANGED" && typeof fromBundleId !== "string") {
      return false;
    }
  }
  if (Object.hasOwn(data, "update_strategy")) {
    const updateStrategy = data.update_strategy;
    if (type === "UNCHANGED" && updateStrategy !== null) return false;
    if (
      type !== "UNCHANGED" &&
      updateStrategy !== "fingerprint" &&
      updateStrategy !== "appVersion"
    ) {
      return false;
    }
  }
  return true;
};

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
  if (model === "bundle_events" && !isBundleEventProjectionShape(data)) {
    throw new DatabasePluginInputError("invalid-data");
  }
};

export const selectRow = <
  TModel extends DatabaseModel,
  TSelect extends DatabaseSelect<TModel> | undefined,
>(
  row: DatabaseImplementationResult,
  select: DatabaseSelect<TModel> | undefined,
): SelectedDatabaseRow<TModel, TSelect> => {
  if (!select) return row as SelectedDatabaseRow<TModel, TSelect>;
  return Object.fromEntries(
    select.map((field) => [field, Reflect.get(row, field)]),
  ) as SelectedDatabaseRow<TModel, TSelect>;
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
  if (
    model === "bundle_events" &&
    Object.hasOwn(row, "type") &&
    !isBundleEventProjectionShape(row)
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
};
