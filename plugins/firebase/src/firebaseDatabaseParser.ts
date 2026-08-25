import {
  isDatabaseMetadataObject,
  type BundlePatchRow,
  type BundleRow,
  type BundleEventRow,
  type ChannelRow,
  type ApiKeyRow,
  type ReleaseCatalogRow,
  type ReleaseRow,
} from "@hot-updater/plugin-core";

import {
  boolean,
  byteSize,
  FirebaseDatabaseDataError,
  nullableString,
  number,
  platform,
  property,
  record,
  string,
  stringArray,
} from "./firebaseDatabaseParserShared";
export {
  FirebaseDatabaseDataError,
  hasFirebaseProperty,
  property,
} from "./firebaseDatabaseParserShared";

const metadata = (value: unknown, source: string) => {
  if (!isDatabaseMetadataObject(value)) {
    throw new FirebaseDatabaseDataError(source);
  }
  return value;
};

const requiredNullableString = (
  input: object,
  key: string,
  source: string,
): string | null => {
  if (!Object.hasOwn(input, key)) throw new FirebaseDatabaseDataError(source);
  return nullableString(property(input, key), source);
};

export const parseFirebaseBundleRow = (
  value: unknown,
  source: string,
): BundleRow => {
  const input = record(value, source);
  return {
    id: string(property(input, "id"), source),
    platform: platform(property(input, "platform"), source),
    file_hash: string(property(input, "file_hash"), source),
    git_commit_hash: nullableString(property(input, "git_commit_hash"), source),
    storage_uri: string(property(input, "storage_uri"), source),
    archive_byte_size: byteSize(property(input, "archive_byte_size"), source),
    metadata: metadata(property(input, "metadata"), source),
    manifest_storage_uri: nullableString(
      property(input, "manifest_storage_uri"),
      source,
    ),
    manifest_file_hash: nullableString(
      property(input, "manifest_file_hash"),
      source,
    ),
    asset_base_storage_uri: nullableString(
      property(input, "asset_base_storage_uri"),
      source,
    ),
  };
};

export const parseFirebaseChannelRow = (
  value: unknown,
  source: string,
): ChannelRow => {
  const input = record(value, source);
  return {
    id: string(property(input, "id"), source),
    name: string(property(input, "name"), source),
  };
};

export const parseFirebasePatchRow = (
  value: unknown,
  source: string,
): BundlePatchRow => {
  const input = record(value, source);
  return {
    id: string(property(input, "id"), source),
    bundle_id: string(property(input, "bundle_id"), source),
    base_bundle_id: string(property(input, "base_bundle_id"), source),
    base_file_hash: string(property(input, "base_file_hash"), source),
    patch_file_hash: string(property(input, "patch_file_hash"), source),
    patch_storage_uri: string(property(input, "patch_storage_uri"), source),
    byte_size: byteSize(property(input, "byte_size"), source),
    order_index: number(property(input, "order_index"), source),
  };
};

export const parseFirebaseBundleEventRow = (
  value: unknown,
  source: string,
): BundleEventRow => {
  const input = record(value, source);
  const type = string(property(input, "type"), source);
  const fromBundleId = requiredNullableString(input, "from_bundle_id", source);
  const updateStrategy = requiredNullableString(
    input,
    "update_strategy",
    source,
  );
  if (
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
    throw new FirebaseDatabaseDataError(source);
  }
  return {
    id: string(property(input, "id"), source),
    type,
    install_id: string(property(input, "install_id"), source),
    user_id: nullableString(property(input, "user_id"), source),
    username: nullableString(property(input, "username"), source),
    from_release_id: requiredNullableString(input, "from_release_id", source),
    from_bundle_id: fromBundleId,
    to_release_id: requiredNullableString(input, "to_release_id", source),
    to_bundle_id: string(property(input, "to_bundle_id"), source),
    platform: platform(property(input, "platform"), source),
    app_version: string(property(input, "app_version"), source),
    channel: string(property(input, "channel"), source),
    cohort: string(property(input, "cohort"), source),
    update_strategy: updateStrategy,
    fingerprint_hash: nullableString(
      property(input, "fingerprint_hash"),
      source,
    ),
    sdk_version: nullableString(property(input, "sdk_version"), source),
    received_at_ms: number(property(input, "received_at_ms"), source),
  } as BundleEventRow;
};

export const parseFirebaseApiKeyRow = (
  value: unknown,
  source: string,
): ApiKeyRow => {
  const input = record(value, source);
  const role = string(property(input, "role"), source);
  if (role !== "client") throw new FirebaseDatabaseDataError(source);
  const revokedAt = property(input, "revoked_at_ms");
  return {
    id: string(property(input, "id"), source),
    hash: string(property(input, "hash"), source),
    name: string(property(input, "name"), source),
    prefix: string(property(input, "prefix"), source),
    role,
    created_at_ms: number(property(input, "created_at_ms"), source),
    revoked_at_ms: revokedAt === null ? null : number(revokedAt, source),
  };
};

export const parseFirebaseReleaseRow = (
  value: unknown,
  source: string,
): ReleaseRow => {
  const input = record(value, source);
  const kind = string(property(input, "kind"), source);
  const strategy = string(property(input, "strategy"), source);
  const operation = string(property(input, "operation"), source);
  const targetCohorts = stringArray(property(input, "target_cohorts"), source);
  if (
    (kind !== "BUNDLE" && kind !== "EMBEDDED") ||
    (strategy !== "APP_VERSION" && strategy !== "FINGERPRINT") ||
    (operation !== "DEPLOY" &&
      operation !== "PROMOTE" &&
      operation !== "ROLLBACK") ||
    targetCohorts === null
  ) {
    throw new FirebaseDatabaseDataError(source);
  }
  return {
    id: string(property(input, "id"), source),
    revision: number(property(input, "revision"), source),
    scope_key: string(property(input, "scope_key"), source),
    channel_id: string(property(input, "channel_id"), source),
    platform: platform(property(input, "platform"), source),
    kind,
    bundle_id: nullableString(property(input, "bundle_id"), source),
    strategy,
    target_app_version: nullableString(
      property(input, "target_app_version"),
      source,
    ),
    fingerprint_hash: nullableString(
      property(input, "fingerprint_hash"),
      source,
    ),
    enabled: boolean(property(input, "enabled"), source),
    should_force_update: boolean(
      property(input, "should_force_update"),
      source,
    ),
    message: nullableString(property(input, "message"), source),
    rollout_cohort_count: number(
      property(input, "rollout_cohort_count"),
      source,
    ),
    target_cohorts: targetCohorts,
    operation,
    source_release_id: nullableString(
      property(input, "source_release_id"),
      source,
    ),
    created_at_ms: number(property(input, "created_at_ms"), source),
    updated_at_ms: number(property(input, "updated_at_ms"), source),
  };
};

export const parseFirebaseReleaseCatalogRow = (
  value: unknown,
  source: string,
): ReleaseCatalogRow => {
  const input = record(value, source);
  const strategy = string(property(input, "strategy"), source);
  if (strategy !== "APP_VERSION" && strategy !== "FINGERPRINT") {
    throw new FirebaseDatabaseDataError(source);
  }
  return {
    scope_key: string(property(input, "scope_key"), source),
    authority_id: string(property(input, "authority_id"), source),
    strategy,
    channel_id: string(property(input, "channel_id"), source),
    channel_key: string(property(input, "channel_key"), source),
    platform: platform(property(input, "platform"), source),
    fingerprint_hash: nullableString(
      property(input, "fingerprint_hash"),
      source,
    ),
    generation: number(property(input, "generation"), source),
    payload: string(property(input, "payload"), source),
    catalog_hash: string(property(input, "catalog_hash"), source),
    byte_size: number(property(input, "byte_size"), source),
    is_tombstone: boolean(property(input, "is_tombstone"), source),
    updated_at_ms: number(property(input, "updated_at_ms"), source),
  };
};
