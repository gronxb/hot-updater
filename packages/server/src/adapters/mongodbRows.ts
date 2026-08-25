import {
  isDatabaseMetadataObject,
  type BundlePatchRow,
  type BundleRow,
  type ChannelRow,
} from "@hot-updater/plugin-core";

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

const metadata = (value: unknown, source: string) => {
  if (!isDatabaseMetadataObject(value)) {
    throw new MongoAdapterDataError(source);
  }
  return value;
};

export const parseMongoBundleRow = (
  value: unknown,
  source = "bundles",
): BundleRow => {
  const input = record(value, source);
  return {
    id: string(input["id"], source),
    platform: platform(input["platform"], source),
    file_hash: string(input["file_hash"], source),
    git_commit_hash: nullableString(input["git_commit_hash"], source),
    storage_uri: string(input["storage_uri"], source),
    archive_byte_size: integer(
      input["archive_byte_size"],
      source,
      Number.MAX_SAFE_INTEGER,
    ),
    metadata: metadata(input["metadata"], source),
    manifest_storage_uri: nullableString(input["manifest_storage_uri"], source),
    manifest_file_hash: nullableString(input["manifest_file_hash"], source),
    asset_base_storage_uri: nullableString(
      input["asset_base_storage_uri"],
      source,
    ),
  };
};

export const parseMongoChannelRow = (
  value: unknown,
  source = "channels",
): ChannelRow => {
  const input = record(value, source);
  return {
    id: string(input["id"], source),
    name: string(input["name"], source),
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
    byte_size: integer(input["byte_size"], source, Number.MAX_SAFE_INTEGER),
    order_index: integer(input["order_index"], source),
  };
};
