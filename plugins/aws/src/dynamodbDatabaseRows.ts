import type { BundlePatchRow, BundleRow } from "@hot-updater/plugin-core";
import { isDatabaseMetadataObject } from "@hot-updater/plugin-core";

export type DynamoDBBundleItem = {
  readonly pk: "bundles";
  readonly sk: string;
  readonly version: number;
  readonly relation_count: number;
  readonly owned_patch_count: number;
  readonly gsi1pk: string;
  readonly gsi1sk: string;
  readonly row: BundleRow;
};

export type DynamoDBPatchItem = {
  readonly pk: "bundle_patches";
  readonly sk: string;
  readonly version: number;
  readonly gsi1pk: string;
  readonly gsi1sk: string;
  readonly row: BundlePatchRow;
};

export type DynamoDBItem = DynamoDBBundleItem | DynamoDBPatchItem;

export class DynamoDBStoredItemError extends Error {
  readonly name = "DynamoDBStoredItemError";

  constructor() {
    super("DynamoDB contains an invalid Hot Updater row");
  }
}

const field = (value: object, name: string): unknown =>
  Reflect.get(value, name);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isStringArrayOrNull = (
  value: unknown,
): value is readonly string[] | null =>
  value === null ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

const isBundleRow = (value: unknown): value is BundleRow =>
  typeof value === "object" &&
  value !== null &&
  typeof field(value, "id") === "string" &&
  (field(value, "platform") === "ios" ||
    field(value, "platform") === "android") &&
  typeof field(value, "should_force_update") === "boolean" &&
  typeof field(value, "enabled") === "boolean" &&
  typeof field(value, "file_hash") === "string" &&
  isNullableString(field(value, "git_commit_hash")) &&
  isNullableString(field(value, "message")) &&
  typeof field(value, "channel") === "string" &&
  typeof field(value, "storage_uri") === "string" &&
  isNullableString(field(value, "target_app_version")) &&
  isNullableString(field(value, "fingerprint_hash")) &&
  isDatabaseMetadataObject(field(value, "metadata")) &&
  typeof field(value, "rollout_cohort_count") === "number" &&
  isStringArrayOrNull(field(value, "target_cohorts")) &&
  isNullableString(field(value, "manifest_storage_uri")) &&
  isNullableString(field(value, "manifest_file_hash")) &&
  isNullableString(field(value, "asset_base_storage_uri"));

const isPatchRow = (value: unknown): value is BundlePatchRow =>
  typeof value === "object" &&
  value !== null &&
  typeof field(value, "id") === "string" &&
  typeof field(value, "bundle_id") === "string" &&
  typeof field(value, "base_bundle_id") === "string" &&
  typeof field(value, "base_file_hash") === "string" &&
  typeof field(value, "patch_file_hash") === "string" &&
  typeof field(value, "patch_storage_uri") === "string" &&
  typeof field(value, "order_index") === "number";

export const parseDynamoDBItem = (
  value: Record<string, unknown>,
): DynamoDBItem => {
  const pk = value.pk;
  const sk = value.sk;
  const version = value.version;
  const relationCount = value.relation_count;
  const ownedPatchCount = value.owned_patch_count;
  const gsi1pk = value.gsi1pk;
  const gsi1sk = value.gsi1sk;
  const row = value.row;
  if (
    typeof sk !== "string" ||
    typeof version !== "number" ||
    typeof gsi1pk !== "string" ||
    typeof gsi1sk !== "string"
  ) {
    throw new DynamoDBStoredItemError();
  }
  if (pk === "bundles" && isBundleRow(row)) {
    if (
      typeof relationCount !== "number" ||
      typeof ownedPatchCount !== "number"
    ) {
      throw new DynamoDBStoredItemError();
    }
    return {
      pk,
      sk,
      version,
      relation_count: relationCount,
      owned_patch_count: ownedPatchCount,
      gsi1pk,
      gsi1sk,
      row,
    };
  }
  if (pk === "bundle_patches" && isPatchRow(row)) {
    return { pk, sk, version, gsi1pk, gsi1sk, row };
  }
  throw new DynamoDBStoredItemError();
};

export const bundleUpdatePartition = (
  row: Pick<BundleRow, "channel" | "enabled" | "platform">,
): string =>
  [
    "bundle",
    row.platform,
    row.channel,
    row.enabled ? "enabled" : "disabled",
  ].join("#");

export const patchOwnerPartition = (bundleId: string): string =>
  `patch-owner#${bundleId}`;

const patchOrderKey = (row: BundlePatchRow): string =>
  `${row.order_index.toString().padStart(10, "0")}#${row.id}`;

export const toDynamoDBBundleItem = (
  row: BundleRow,
  version = 1,
  relationCount = 0,
  ownedPatchCount = 0,
): DynamoDBBundleItem => ({
  pk: "bundles",
  sk: row.id,
  version,
  relation_count: relationCount,
  owned_patch_count: ownedPatchCount,
  gsi1pk: bundleUpdatePartition(row),
  gsi1sk: row.id,
  row,
});

export const toDynamoDBPatchItem = (
  row: BundlePatchRow,
  version = 1,
): DynamoDBPatchItem => {
  const orderKey = patchOrderKey(row);
  return {
    pk: "bundle_patches",
    sk: row.id,
    version,
    gsi1pk: patchOwnerPartition(row.bundle_id),
    gsi1sk: orderKey,
    row,
  };
};

export const itemKey = (model: "bundles" | "bundle_patches", id: string) => ({
  pk: model,
  sk: id,
});
