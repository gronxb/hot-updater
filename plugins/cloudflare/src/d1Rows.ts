import type {
  BundlePatchRow,
  BundleRow,
  DatabaseModel,
  DatabaseRow,
} from "@hot-updater/plugin-core";
import { isDatabaseMetadataObject } from "@hot-updater/plugin-core";

class InvalidD1RowError extends Error {
  readonly name = "InvalidD1RowError";
  readonly model: DatabaseModel;

  constructor(model: DatabaseModel) {
    super(`D1 returned an invalid ${model} row`);
    this.model = model;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (
  row: Record<string, unknown>,
  field: string,
  model: DatabaseModel,
): string => {
  const value = row[field];
  if (typeof value !== "string") throw new InvalidD1RowError(model);
  return value;
};

const nullableString = (
  row: Record<string, unknown>,
  field: string,
  model: DatabaseModel,
): string | null => {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new InvalidD1RowError(model);
  return value;
};

const numberValue = (
  row: Record<string, unknown>,
  field: string,
  model: DatabaseModel,
): number => {
  const value = row[field];
  if (typeof value !== "number") throw new InvalidD1RowError(model);
  return value;
};

const booleanValue = (
  row: Record<string, unknown>,
  field: string,
  model: DatabaseModel,
): boolean => {
  const value = row[field];
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new InvalidD1RowError(model);
};

const jsonValue = (value: unknown, model: DatabaseModel): unknown => {
  if (typeof value !== "string") throw new InvalidD1RowError(model);
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) throw new InvalidD1RowError(model);
    throw error;
  }
};

const targetCohorts = (
  row: Record<string, unknown>,
): readonly string[] | null => {
  if (row["target_cohorts"] === null) return null;
  const value = jsonValue(row["target_cohorts"], "bundles");
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new InvalidD1RowError("bundles");
  }
  return value.filter((item): item is string => typeof item === "string");
};

const metadata = (row: Record<string, unknown>) => {
  const value = jsonValue(row["metadata"], "bundles");
  if (!isDatabaseMetadataObject(value)) {
    throw new InvalidD1RowError("bundles");
  }
  return value;
};

const bundleRow = (row: Record<string, unknown>): BundleRow => {
  const platform = stringValue(row, "platform", "bundles");
  if (platform !== "ios" && platform !== "android") {
    throw new InvalidD1RowError("bundles");
  }
  return {
    id: stringValue(row, "id", "bundles"),
    platform,
    should_force_update: booleanValue(row, "should_force_update", "bundles"),
    enabled: booleanValue(row, "enabled", "bundles"),
    file_hash: stringValue(row, "file_hash", "bundles"),
    git_commit_hash: nullableString(row, "git_commit_hash", "bundles"),
    message: nullableString(row, "message", "bundles"),
    channel: stringValue(row, "channel", "bundles"),
    storage_uri: stringValue(row, "storage_uri", "bundles"),
    target_app_version: nullableString(row, "target_app_version", "bundles"),
    fingerprint_hash: nullableString(row, "fingerprint_hash", "bundles"),
    metadata: metadata(row),
    rollout_cohort_count: numberValue(row, "rollout_cohort_count", "bundles"),
    target_cohorts: targetCohorts(row),
    manifest_storage_uri: nullableString(
      row,
      "manifest_storage_uri",
      "bundles",
    ),
    manifest_file_hash: nullableString(row, "manifest_file_hash", "bundles"),
    asset_base_storage_uri: nullableString(
      row,
      "asset_base_storage_uri",
      "bundles",
    ),
  };
};

const patchRow = (row: Record<string, unknown>): BundlePatchRow => ({
  id: stringValue(row, "id", "bundle_patches"),
  bundle_id: stringValue(row, "bundle_id", "bundle_patches"),
  base_bundle_id: stringValue(row, "base_bundle_id", "bundle_patches"),
  base_file_hash: stringValue(row, "base_file_hash", "bundle_patches"),
  patch_file_hash: stringValue(row, "patch_file_hash", "bundle_patches"),
  patch_storage_uri: stringValue(row, "patch_storage_uri", "bundle_patches"),
  order_index: numberValue(row, "order_index", "bundle_patches"),
});

export function parseD1Row(model: "bundles", value: unknown): BundleRow;
export function parseD1Row(
  model: "bundle_patches",
  value: unknown,
): BundlePatchRow;
export function parseD1Row(
  model: DatabaseModel,
  value: unknown,
): DatabaseRow<DatabaseModel>;
export function parseD1Row(
  model: DatabaseModel,
  value: unknown,
): DatabaseRow<DatabaseModel> {
  if (!isRecord(value)) throw new InvalidD1RowError(model);
  switch (model) {
    case "bundles":
      return bundleRow(value);
    case "bundle_patches":
      return patchRow(value);
  }
}
