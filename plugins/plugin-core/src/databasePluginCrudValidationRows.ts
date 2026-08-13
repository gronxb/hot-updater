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

const hasValidReleaseInvariants = (
  data: Readonly<Record<string, unknown>>,
): boolean => {
  const kind = data.kind;
  const bundleId = data.bundle_id;
  const strategy = data.strategy;
  const targetAppVersion = data.target_app_version;
  const fingerprintHash = data.fingerprint_hash;
  return (
    ((kind === "BUNDLE" && typeof bundleId === "string") ||
      (kind === "EMBEDDED" && bundleId === null)) &&
    ((strategy === "APP_VERSION" &&
      typeof targetAppVersion === "string" &&
      fingerprintHash === null) ||
      (strategy === "FINGERPRINT" &&
        targetAppVersion === null &&
        typeof fingerprintHash === "string"))
  );
};

const isOptionalLegacyAnalyticsField = (
  model: DatabaseModel,
  field: string,
): boolean =>
  model === "bundle_events" &&
  (field === "from_release_id" || field === "to_release_id");

export const validateCreateData = (
  model: DatabaseModel,
  data: unknown,
): void => {
  if (!isRecord(data)) throw new DatabasePluginInputError("invalid-data");
  validateFields(model, Object.keys(data));
  for (const field of databaseFields[model]) {
    if (
      !Object.hasOwn(data, field) &&
      isOptionalLegacyAnalyticsField(model, field)
    ) {
      continue;
    }
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
  if (model === "releases" && !hasValidReleaseInvariants(data)) {
    throw new DatabasePluginInputError("invalid-data");
  }
  if (
    model === "release_catalogs" &&
    ((data.strategy === "APP_VERSION" && data.fingerprint_hash !== null) ||
      (data.strategy === "FINGERPRINT" &&
        typeof data.fingerprint_hash !== "string"))
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
    if (
      !Object.hasOwn(row, field) &&
      isOptionalLegacyAnalyticsField(model, field)
    ) {
      continue;
    }
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
    model === "releases" &&
    [
      "kind",
      "bundle_id",
      "strategy",
      "target_app_version",
      "fingerprint_hash",
    ].every((field) => Object.hasOwn(row, field)) &&
    !hasValidReleaseInvariants(row)
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
};
