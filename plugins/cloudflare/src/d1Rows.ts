import type {
  BundlePatchRow,
  BundleRow,
  DatabaseModel,
  DatabaseRow,
} from "@hot-updater/plugin-core";

type BundleEventPersistenceRow = DatabaseRow<"bundle_events">;

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

const jsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return value;
    throw error;
  }
};

const targetCohorts = (
  row: Record<string, unknown>,
): readonly string[] | null => {
  const value = jsonValue(row["target_cohorts"]);
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new InvalidD1RowError("bundles");
  }
  return value.filter((item): item is string => typeof item === "string");
};

const bundleRow = (row: Record<string, unknown>): BundleRow => {
  const platform = stringValue(row, "platform", "bundles");
  if (platform !== "ios" && platform !== "android") {
    throw new InvalidD1RowError("bundles");
  }
  return {
    id: stringValue(row, "id", "bundles"),
    platform,
    should_force_update: Boolean(row["should_force_update"]),
    enabled: Boolean(row["enabled"]),
    file_hash: stringValue(row, "file_hash", "bundles"),
    git_commit_hash: nullableString(row, "git_commit_hash", "bundles"),
    message: nullableString(row, "message", "bundles"),
    channel: stringValue(row, "channel", "bundles"),
    storage_uri: stringValue(row, "storage_uri", "bundles"),
    target_app_version: nullableString(row, "target_app_version", "bundles"),
    fingerprint_hash: nullableString(row, "fingerprint_hash", "bundles"),
    metadata: jsonValue(row["metadata"]),
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

const bundleEventRow = (
  row: Record<string, unknown>,
): BundleEventPersistenceRow => {
  const type = stringValue(row, "type", "bundle_events");
  const fromBundleId = nullableString(row, "from_bundle_id", "bundle_events");
  const updateStrategy = nullableString(
    row,
    "update_strategy",
    "bundle_events",
  );
  const platformValue = stringValue(row, "platform", "bundle_events");
  if (platformValue !== "ios" && platformValue !== "android") {
    throw new InvalidD1RowError("bundle_events");
  }
  const platform = platformValue === "ios" ? "ios" : "android";
  const common = {
    id: stringValue(row, "id", "bundle_events"),
    install_id: stringValue(row, "install_id", "bundle_events"),
    user_id: nullableString(row, "user_id", "bundle_events"),
    username: nullableString(row, "username", "bundle_events"),
    to_bundle_id: stringValue(row, "to_bundle_id", "bundle_events"),
    app_version: stringValue(row, "app_version", "bundle_events"),
    channel: stringValue(row, "channel", "bundle_events"),
    cohort: stringValue(row, "cohort", "bundle_events"),
    fingerprint_hash: nullableString(row, "fingerprint_hash", "bundle_events"),
    sdk_version: nullableString(row, "sdk_version", "bundle_events"),
    received_at_ms: numberValue(row, "received_at_ms", "bundle_events"),
  };

  switch (type) {
    case "UNCHANGED":
      if (fromBundleId !== null || updateStrategy !== null) {
        throw new InvalidD1RowError("bundle_events");
      }
      return {
        ...common,
        platform,
        type: "UNCHANGED",
        from_bundle_id: null,
        update_strategy: null,
      };
    case "UPDATE_APPLIED":
      if (
        fromBundleId === null ||
        (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion")
      ) {
        throw new InvalidD1RowError("bundle_events");
      }
      return {
        ...common,
        platform,
        type: "UPDATE_APPLIED",
        from_bundle_id: fromBundleId,
        update_strategy: updateStrategy,
      };
    case "RECOVERED":
      if (
        fromBundleId === null ||
        (updateStrategy !== "fingerprint" && updateStrategy !== "appVersion")
      ) {
        throw new InvalidD1RowError("bundle_events");
      }
      return {
        ...common,
        platform,
        type: "RECOVERED",
        from_bundle_id: fromBundleId,
        update_strategy: updateStrategy,
      };
    default:
      throw new InvalidD1RowError("bundle_events");
  }
};

export function parseD1Row(model: "bundles", value: unknown): BundleRow;
export function parseD1Row(
  model: "bundle_patches",
  value: unknown,
): BundlePatchRow;
export function parseD1Row(
  model: "bundle_events",
  value: unknown,
): BundleEventPersistenceRow;
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
    case "bundle_events":
      return bundleEventRow(value);
  }
}
