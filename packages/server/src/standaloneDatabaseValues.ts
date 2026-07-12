import type {
  BundlePatchRow,
  BundleRow,
  ChannelRow,
  DatabaseSortBy,
  DatabaseWhere,
} from "@hot-updater/plugin-core";
import { databaseFields } from "@hot-updater/plugin-core";

export type StandaloneDatabaseModel = "bundle_patches" | "bundles" | "channels";

export const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isNullableStrings = (value: unknown): value is readonly string[] | null =>
  value === null ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

const isBundleField = (field: string): field is keyof BundleRow =>
  databaseFields.bundles.some((candidate) => candidate === field);
const isPatchField = (field: string): field is keyof BundlePatchRow =>
  databaseFields.bundle_patches.some((candidate) => candidate === field);
const isChannelField = (field: string): field is keyof ChannelRow =>
  databaseFields.channels.some((candidate) => candidate === field);

export const bundleValue = (
  field: keyof BundleRow,
  value: unknown,
): boolean => {
  switch (field) {
    case "enabled":
    case "should_force_update":
      return typeof value === "boolean";
    case "rollout_cohort_count":
      return typeof value === "number" && Number.isInteger(value);
    case "git_commit_hash":
    case "message":
    case "target_app_version":
    case "fingerprint_hash":
    case "manifest_storage_uri":
    case "manifest_file_hash":
    case "asset_base_storage_uri":
      return isNullableString(value);
    case "target_cohorts":
      return isNullableStrings(value);
    case "platform":
      return value === "ios" || value === "android";
    case "metadata":
      return true;
    case "id":
    case "file_hash":
    case "channel":
    case "storage_uri":
      return typeof value === "string";
  }
};

export const patchValue = (
  field: keyof BundlePatchRow,
  value: unknown,
): boolean =>
  field === "order_index"
    ? typeof value === "number" && Number.isInteger(value)
    : typeof value === "string";

export const hasValidFields = <TField extends string>(
  value: Readonly<Record<string, unknown>>,
  fields: readonly TField[],
  validate: (field: TField, fieldValue: unknown) => boolean,
): boolean =>
  Object.entries(value).every(([candidate, fieldValue]) => {
    const field = fields.find((allowed) => allowed === candidate);
    return field !== undefined && validate(field, fieldValue);
  });

export const isBundleRow = (value: unknown): value is BundleRow =>
  isRecord(value) &&
  hasValidFields(value, databaseFields.bundles, bundleValue) &&
  databaseFields.bundles.every((field) => field in value);
export const isPatchRow = (value: unknown): value is BundlePatchRow =>
  isRecord(value) &&
  hasValidFields(value, databaseFields.bundle_patches, patchValue) &&
  databaseFields.bundle_patches.every((field) => field in value);
export const isChannelRow = (value: unknown): value is ChannelRow =>
  isRecord(value) &&
  hasOnlyKeys(value, databaseFields.channels) &&
  typeof value.id === "string";

export const isSelect = (
  model: StandaloneDatabaseModel,
  value: unknown,
): value is readonly string[] => {
  if (!Array.isArray(value) || value.length === 0) return false;
  const fields = databaseFields[model];
  return value.every(
    (field) =>
      typeof field === "string" &&
      fields.some((candidate) => candidate === field),
  );
};

const isWhereEntry = (
  model: StandaloneDatabaseModel,
  value: unknown,
): boolean => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["field", "operator", "value", "connector", "mode"]) ||
    typeof value.field !== "string" ||
    !("value" in value) ||
    (value.connector !== undefined &&
      value.connector !== "AND" &&
      value.connector !== "OR") ||
    (value.mode !== undefined &&
      value.mode !== "sensitive" &&
      value.mode !== "insensitive")
  )
    return false;
  const operator = value.operator ?? "eq";
  const field = value.field;
  const validField =
    model === "bundles"
      ? isBundleField(field)
      : model === "bundle_patches"
        ? isPatchField(field)
        : isChannelField(field);
  if (!validField || typeof operator !== "string") return false;
  const fieldValue = value.value;
  const baseValueValid =
    model === "bundles" && isBundleField(field)
      ? bundleValue(field, fieldValue)
      : model === "bundle_patches" && isPatchField(field)
        ? patchValue(field, fieldValue)
        : model === "channels" && isChannelField(field)
          ? typeof fieldValue === "string"
          : false;
  if (operator === "eq" || operator === "ne") return baseValueValid;
  const numberField =
    (model === "bundle_patches" && field === "order_index") ||
    (model === "bundles" && field === "rollout_cohort_count");
  const booleanField =
    model === "bundles" &&
    (field === "enabled" || field === "should_force_update");
  const stringField = !numberField && !booleanField && field !== "metadata";
  if (["contains", "starts_with", "ends_with"].includes(operator)) {
    return stringField && typeof fieldValue === "string";
  }
  if (["gt", "gte", "lt", "lte"].includes(operator)) {
    return (
      (stringField && typeof fieldValue === "string") ||
      (numberField && typeof fieldValue === "number")
    );
  }
  if (operator === "in" || operator === "not_in") {
    return (
      Array.isArray(fieldValue) &&
      fieldValue.every((item) =>
        stringField
          ? typeof item === "string"
          : numberField
            ? typeof item === "number"
            : typeof item === "boolean",
      )
    );
  }
  return false;
};

export const isWhere = <TModel extends StandaloneDatabaseModel>(
  model: TModel,
  value: unknown,
): value is readonly DatabaseWhere<TModel>[] =>
  Array.isArray(value) && value.every((entry) => isWhereEntry(model, entry));

export const optionalWhere = (model: StandaloneDatabaseModel, value: unknown) =>
  value === undefined || isWhere(model, value);
export const optionalSelect = (
  model: StandaloneDatabaseModel,
  value: unknown,
) => value === undefined || isSelect(model, value);
export const isSort = <TModel extends StandaloneDatabaseModel>(
  model: TModel,
  value: unknown,
): value is DatabaseSortBy<TModel> =>
  isRecord(value) &&
  hasOnlyKeys(value, ["field", "direction"]) &&
  typeof value.field === "string" &&
  isSelect(model, [value.field]) &&
  (value.direction === "asc" || value.direction === "desc");
