import type { BundlePatchRow, BundleRow } from "@hot-updater/plugin-core";

export class MongoAdapterDataError extends Error {
  readonly name = "MongoAdapterDataError";

  constructor(readonly source: string) {
    super(`Invalid MongoDB plugin data at "${source}".`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, source: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new MongoAdapterDataError(source);
  }
  return value;
};

const string = (value: unknown, source: string): string => {
  if (typeof value !== "string") throw new MongoAdapterDataError(source);
  return value;
};

const nullableString = (value: unknown, source: string): string | null => {
  if (value === null || value === undefined) return null;
  return string(value, source);
};

const boolean = (value: unknown, source: string): boolean => {
  if (typeof value !== "boolean") throw new MongoAdapterDataError(source);
  return value;
};

const integer = (
  value: unknown,
  source: string,
  maximum = Number.POSITIVE_INFINITY,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new MongoAdapterDataError(source);
  }
  return value;
};

const platform = (value: unknown, source: string): "android" | "ios" => {
  if (value !== "android" && value !== "ios") {
    throw new MongoAdapterDataError(source);
  }
  return value;
};

const targetCohorts = (
  value: unknown,
  source: string,
): readonly string[] | null => {
  if (value === null || value === undefined) return null;
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new MongoAdapterDataError(source);
  }
  return value;
};

export const parseMongoBundleRow = (
  value: unknown,
  source = "bundles",
): BundleRow => {
  const input = record(value, source);
  const targetAppVersion = nullableString(input["target_app_version"], source);
  const fingerprintHash = nullableString(input["fingerprint_hash"], source);
  if (targetAppVersion === null && fingerprintHash === null) {
    throw new MongoAdapterDataError(source);
  }
  return {
    id: string(input["id"], source),
    platform: platform(input["platform"], source),
    should_force_update: boolean(input["should_force_update"], source),
    enabled: boolean(input["enabled"], source),
    file_hash: string(input["file_hash"], source),
    git_commit_hash: nullableString(input["git_commit_hash"], source),
    message: nullableString(input["message"], source),
    channel: string(input["channel"], source),
    storage_uri: string(input["storage_uri"], source),
    target_app_version: targetAppVersion,
    fingerprint_hash: fingerprintHash,
    metadata: input["metadata"] ?? {},
    rollout_cohort_count:
      input["rollout_cohort_count"] === undefined
        ? 1000
        : integer(input["rollout_cohort_count"], source, 1000),
    target_cohorts: targetCohorts(input["target_cohorts"], source),
    manifest_storage_uri: nullableString(input["manifest_storage_uri"], source),
    manifest_file_hash: nullableString(input["manifest_file_hash"], source),
    asset_base_storage_uri: nullableString(
      input["asset_base_storage_uri"],
      source,
    ),
  };
};

export const parseMongoPatchRow = (
  value: unknown,
  source = "bundle_patches",
): BundlePatchRow => {
  const input = record(value, source);
  return {
    id: string(input["id"], source),
    bundle_id: string(input["bundle_id"], source),
    base_bundle_id: string(input["base_bundle_id"], source),
    base_file_hash: string(input["base_file_hash"], source),
    patch_file_hash: string(input["patch_file_hash"], source),
    patch_storage_uri: string(input["patch_storage_uri"], source),
    order_index: integer(input["order_index"], source),
  };
};
