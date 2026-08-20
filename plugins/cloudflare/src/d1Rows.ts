import type {
  BundlePatchRow,
  BundleRow,
  BundleEventRow,
  ChannelRow,
  ClientAccessKeyRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { isDatabaseMetadataObject } from "@hot-updater/plugin-core";
import type {
  DatabaseModel,
  DatabaseRow,
} from "@hot-updater/plugin-core/internal";

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
    file_hash: stringValue(row, "file_hash", "bundles"),
    git_commit_hash: nullableString(row, "git_commit_hash", "bundles"),
    storage_uri: stringValue(row, "storage_uri", "bundles"),
    metadata: metadata(row),
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

const channelRow = (row: Record<string, unknown>): ChannelRow => ({
  id: stringValue(row, "id", "channels"),
  name: stringValue(row, "name", "channels"),
});

const eventRow = (row: Record<string, unknown>): BundleEventRow => {
  const type = stringValue(row, "type", "bundle_events");
  const platform = stringValue(row, "platform", "bundle_events");
  const fromBundleId = nullableString(row, "from_bundle_id", "bundle_events");
  const updateStrategy = nullableString(
    row,
    "update_strategy",
    "bundle_events",
  );
  if (
    (platform !== "ios" && platform !== "android") ||
    !(
      ((type === "UPDATE_APPLIED" ||
        type === "RECOVERED" ||
        type === "RELEASE_ADOPTED") &&
        typeof fromBundleId === "string" &&
        (updateStrategy === "fingerprint" ||
          updateStrategy === "appVersion")) ||
      (type === "UNCHANGED" && fromBundleId === null && updateStrategy === null)
    )
  ) {
    throw new InvalidD1RowError("bundle_events");
  }
  return {
    id: stringValue(row, "id", "bundle_events"),
    type,
    install_id: stringValue(row, "install_id", "bundle_events"),
    user_id: nullableString(row, "user_id", "bundle_events"),
    username: nullableString(row, "username", "bundle_events"),
    from_release_id: nullableString(row, "from_release_id", "bundle_events"),
    from_bundle_id: fromBundleId,
    to_release_id: nullableString(row, "to_release_id", "bundle_events"),
    to_bundle_id: stringValue(row, "to_bundle_id", "bundle_events"),
    platform,
    app_version: stringValue(row, "app_version", "bundle_events"),
    channel: stringValue(row, "channel", "bundle_events"),
    cohort: stringValue(row, "cohort", "bundle_events"),
    update_strategy: updateStrategy,
    fingerprint_hash: nullableString(row, "fingerprint_hash", "bundle_events"),
    sdk_version: nullableString(row, "sdk_version", "bundle_events"),
    received_at_ms: numberValue(row, "received_at_ms", "bundle_events"),
  } as BundleEventRow;
};

const clientAccessKeyRow = (
  row: Record<string, unknown>,
): ClientAccessKeyRow => {
  const role = stringValue(row, "role", "client_access_keys");
  if (role !== "client") throw new InvalidD1RowError("client_access_keys");
  const revokedAt = row["revoked_at_ms"];
  return {
    id: stringValue(row, "id", "client_access_keys"),
    hash: stringValue(row, "hash", "client_access_keys"),
    name: stringValue(row, "name", "client_access_keys"),
    prefix: stringValue(row, "prefix", "client_access_keys"),
    role,
    created_at_ms: numberValue(row, "created_at_ms", "client_access_keys"),
    revoked_at_ms:
      revokedAt === null
        ? null
        : numberValue(row, "revoked_at_ms", "client_access_keys"),
  };
};

const releaseTargetCohorts = (
  row: Record<string, unknown>,
): readonly string[] => {
  const value = jsonValue(row["target_cohorts"], "releases");
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new InvalidD1RowError("releases");
  }
  return value.filter((item): item is string => typeof item === "string");
};

const releaseRow = (row: Record<string, unknown>): ReleaseRow => {
  const platform = stringValue(row, "platform", "releases");
  const kind = stringValue(row, "kind", "releases");
  const strategy = stringValue(row, "strategy", "releases");
  const operation = stringValue(row, "operation", "releases");
  if (
    (platform !== "ios" && platform !== "android") ||
    (kind !== "BUNDLE" && kind !== "EMBEDDED") ||
    (strategy !== "APP_VERSION" && strategy !== "FINGERPRINT") ||
    (operation !== "DEPLOY" &&
      operation !== "PROMOTE" &&
      operation !== "ROLLBACK")
  ) {
    throw new InvalidD1RowError("releases");
  }
  return {
    id: stringValue(row, "id", "releases"),
    revision: numberValue(row, "revision", "releases"),
    scope_key: stringValue(row, "scope_key", "releases"),
    channel_id: stringValue(row, "channel_id", "releases"),
    platform,
    kind,
    bundle_id: nullableString(row, "bundle_id", "releases"),
    strategy,
    target_app_version: nullableString(row, "target_app_version", "releases"),
    fingerprint_hash: nullableString(row, "fingerprint_hash", "releases"),
    enabled: booleanValue(row, "enabled", "releases"),
    should_force_update: booleanValue(row, "should_force_update", "releases"),
    message: nullableString(row, "message", "releases"),
    rollout_cohort_count: numberValue(row, "rollout_cohort_count", "releases"),
    target_cohorts: releaseTargetCohorts(row),
    operation,
    source_release_id: nullableString(row, "source_release_id", "releases"),
    created_at_ms: numberValue(row, "created_at_ms", "releases"),
    updated_at_ms: numberValue(row, "updated_at_ms", "releases"),
  };
};

const releaseCatalogRow = (row: Record<string, unknown>): ReleaseCatalogRow => {
  const platform = stringValue(row, "platform", "release_catalogs");
  const strategy = stringValue(row, "strategy", "release_catalogs");
  if (
    (platform !== "ios" && platform !== "android") ||
    (strategy !== "APP_VERSION" && strategy !== "FINGERPRINT")
  ) {
    throw new InvalidD1RowError("release_catalogs");
  }
  return {
    scope_key: stringValue(row, "scope_key", "release_catalogs"),
    authority_id: stringValue(row, "authority_id", "release_catalogs"),
    strategy,
    channel_id: stringValue(row, "channel_id", "release_catalogs"),
    channel_key: stringValue(row, "channel_key", "release_catalogs"),
    platform,
    fingerprint_hash: nullableString(
      row,
      "fingerprint_hash",
      "release_catalogs",
    ),
    generation: numberValue(row, "generation", "release_catalogs"),
    payload: stringValue(row, "payload", "release_catalogs"),
    catalog_hash: stringValue(row, "catalog_hash", "release_catalogs"),
    byte_size: numberValue(row, "byte_size", "release_catalogs"),
    is_tombstone: booleanValue(row, "is_tombstone", "release_catalogs"),
    updated_at_ms: numberValue(row, "updated_at_ms", "release_catalogs"),
  };
};

export function parseD1Row(model: "bundles", value: unknown): BundleRow;
export function parseD1Row(model: "channels", value: unknown): ChannelRow;
export function parseD1Row(
  model: "bundle_patches",
  value: unknown,
): BundlePatchRow;
export function parseD1Row(
  model: "bundle_events",
  value: unknown,
): BundleEventRow;
export function parseD1Row(
  model: "client_access_keys",
  value: unknown,
): ClientAccessKeyRow;
export function parseD1Row(model: "releases", value: unknown): ReleaseRow;
export function parseD1Row(
  model: "release_catalogs",
  value: unknown,
): ReleaseCatalogRow;
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
    case "channels":
      return channelRow(value);
    case "bundle_events":
      return eventRow(value);
    case "client_access_keys":
      return clientAccessKeyRow(value);
    case "releases":
      return releaseRow(value);
    case "release_catalogs":
      return releaseCatalogRow(value);
  }
}
