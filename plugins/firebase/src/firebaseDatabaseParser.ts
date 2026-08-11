import {
  isDatabaseMetadataObject,
  type BundlePatchRow,
  type BundleRow,
  type BundleEventRow,
  type ClientAccessKeyRow,
} from "@hot-updater/plugin-core";

export class FirebaseDatabaseDataError extends Error {
  readonly name = "FirebaseDatabaseDataError";

  constructor(readonly source: string) {
    super(`Invalid Firebase database data at "${source}".`);
  }
}

const record = (value: unknown, source: string): object => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FirebaseDatabaseDataError(source);
  }
  return value;
};

export const property = (value: object, key: string): unknown =>
  Reflect.get(value, key);

export const hasFirebaseProperty = (value: unknown, key: string): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  key in value;

const string = (value: unknown, source: string): string => {
  if (typeof value !== "string") throw new FirebaseDatabaseDataError(source);
  return value;
};

const nullableString = (value: unknown, source: string): string | null => {
  if (value === null || value === undefined) return null;
  return string(value, source);
};

const boolean = (value: unknown, source: string): boolean => {
  if (typeof value !== "boolean") throw new FirebaseDatabaseDataError(source);
  return value;
};

const number = (value: unknown, source: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FirebaseDatabaseDataError(source);
  }
  return value;
};

const stringArray = (
  value: unknown,
  source: string,
): readonly string[] | null => {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new FirebaseDatabaseDataError(source);
  return value.map((item) => string(item, source));
};

const platform = (value: unknown, source: string): "android" | "ios" => {
  if (value === "android" || value === "ios") return value;
  throw new FirebaseDatabaseDataError(source);
};

const metadata = (value: unknown, source: string) => {
  const normalized = value === undefined ? {} : value;
  if (!isDatabaseMetadataObject(normalized)) {
    throw new FirebaseDatabaseDataError(source);
  }
  return normalized;
};

export const parseFirebaseBundleRow = (
  value: unknown,
  source: string,
): BundleRow => {
  const input = record(value, source);
  return {
    id: string(property(input, "id"), source),
    platform: platform(property(input, "platform"), source),
    should_force_update: boolean(
      property(input, "should_force_update"),
      source,
    ),
    enabled: boolean(property(input, "enabled"), source),
    file_hash: string(property(input, "file_hash"), source),
    git_commit_hash: nullableString(property(input, "git_commit_hash"), source),
    message: nullableString(property(input, "message"), source),
    channel: string(property(input, "channel"), source),
    storage_uri: string(property(input, "storage_uri"), source),
    target_app_version: nullableString(
      property(input, "target_app_version"),
      source,
    ),
    fingerprint_hash: nullableString(
      property(input, "fingerprint_hash"),
      source,
    ),
    metadata: metadata(property(input, "metadata"), source),
    rollout_cohort_count:
      property(input, "rollout_cohort_count") === undefined
        ? 1000
        : number(property(input, "rollout_cohort_count"), source),
    target_cohorts: stringArray(property(input, "target_cohorts"), source),
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
    order_index: number(property(input, "order_index"), source),
  };
};

export const parseFirebaseBundleEventRow = (
  value: unknown,
  source: string,
): BundleEventRow => {
  const input = record(value, source);
  const type = string(property(input, "type"), source);
  const fromBundleId = nullableString(
    property(input, "from_bundle_id"),
    source,
  );
  const updateStrategy = nullableString(
    property(input, "update_strategy"),
    source,
  );
  if (
    !(
      ((type === "UPDATE_APPLIED" || type === "RECOVERED") &&
        fromBundleId !== null &&
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
    from_bundle_id: fromBundleId,
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

export const parseFirebaseClientAccessKeyRow = (
  value: unknown,
  source: string,
): ClientAccessKeyRow => {
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

type LegacyPatchInput = {
  readonly value: unknown;
  readonly bundleId: string;
  readonly orderIndex: number;
  readonly source: string;
};

const parseLegacyPatch = ({
  value,
  bundleId,
  orderIndex,
  source,
}: LegacyPatchInput): BundlePatchRow => {
  const input = record(value, source);
  const baseBundleId = string(property(input, "baseBundleId"), source);
  return {
    id: `${bundleId}:${baseBundleId}`,
    bundle_id: bundleId,
    base_bundle_id: baseBundleId,
    base_file_hash: string(property(input, "baseFileHash"), source),
    patch_file_hash: string(property(input, "patchFileHash"), source),
    patch_storage_uri: string(property(input, "patchStorageUri"), source),
    order_index: orderIndex,
  };
};

export const parseFirebaseLegacyPatchRows = (
  value: unknown,
  bundleId: string,
  source: string,
): readonly BundlePatchRow[] => {
  const input = record(value, source);
  const patches = property(input, "patches");
  if (Array.isArray(patches)) {
    return patches.map((patch, index) =>
      parseLegacyPatch({ value: patch, bundleId, orderIndex: index, source }),
    );
  }
  const baseBundleId = property(input, "patch_base_bundle_id");
  if (baseBundleId === null || baseBundleId === undefined) return [];
  return [
    {
      id: `${bundleId}:${string(baseBundleId, source)}`,
      bundle_id: bundleId,
      base_bundle_id: string(baseBundleId, source),
      base_file_hash: string(property(input, "patch_base_file_hash"), source),
      patch_file_hash: string(property(input, "patch_file_hash"), source),
      patch_storage_uri: string(property(input, "patch_storage_uri"), source),
      order_index: 0,
    },
  ];
};
