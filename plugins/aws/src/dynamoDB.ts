import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  type NativeAttributeValue,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  type BundlePatchRow,
  type BundleRow,
  type InsightsModel,
  type ChannelDeleteInput,
  type ChannelDeleteResult,
  type ChannelInsertInput,
  type ChannelInsertResult,
  type ChannelRow,
  type ApiKeyRow,
  type ApiKeyModel,
  createDatabasePlugin,
  type DatabaseCommit,
  type DatabaseCommitResult,
  isDatabaseMetadataObject,
  type ReleaseCatalogRow,
  type ReleaseRow,
} from "@hot-updater/plugin-core";
import {
  createDatabasePluginAdapter,
  type DatabaseDistinctOn,
  type DatabaseImplementationResult,
  type DatabaseModel,
  type DatabaseOrderBy,
  type DatabasePluginImplementation,
  type DatabaseRow,
  type DatabaseWhere,
} from "@hot-updater/plugin-core/internal";

import { invalidateCloudFront } from "./cloudFrontInvalidation";
import { createDynamoDBInsightsModel } from "./dynamoDBInsightsV2Jobs";

export const DYNAMODB_MAX_METADATA_ITEM_BYTES = 8 * 1_024;
export const DYNAMODB_MAX_CATALOG_ITEM_BYTES = 400 * 1_024;

export class DynamoDBMetadataItemSizeError extends Error {
  readonly name = "DynamoDBMetadataItemSizeError";

  constructor(readonly byteLength: number) {
    super(
      `DynamoDB metadata item is ${byteLength} bytes; maximum is ${DYNAMODB_MAX_METADATA_ITEM_BYTES}`,
    );
  }
}

export const boundedDynamoDBMetadataItem = <TItem extends object>(
  item: TItem,
): TItem => {
  const byteLength = new TextEncoder().encode(JSON.stringify(item)).byteLength;
  if (byteLength > DYNAMODB_MAX_METADATA_ITEM_BYTES) {
    throw new DynamoDBMetadataItemSizeError(byteLength);
  }
  return item;
};

export class DynamoDBCatalogItemSizeError extends Error {
  readonly name = "DynamoDBCatalogItemSizeError";

  constructor(readonly byteLength: number) {
    super(
      `DynamoDB catalog item is ${byteLength} bytes; maximum is ${DYNAMODB_MAX_CATALOG_ITEM_BYTES}`,
    );
  }
}

export const boundedDynamoDBCatalogItem = <TItem extends object>(
  item: TItem,
): TItem => {
  const byteLength = new TextEncoder().encode(JSON.stringify(item)).byteLength;
  if (byteLength > DYNAMODB_MAX_CATALOG_ITEM_BYTES) {
    throw new DynamoDBCatalogItemSizeError(byteLength);
  }
  return item;
};

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

export const DYNAMODB_CHANNEL_PARTITION = "channels";
export const DYNAMODB_CHANNEL_NAME_PARTITION = "_hot-updater#channel-names";

export type DynamoDBChannelItem = {
  readonly pk: typeof DYNAMODB_CHANNEL_PARTITION;
  readonly sk: string;
  readonly version: number;
  readonly reference_count: number;
  readonly row: ChannelRow;
};

export type DynamoDBReleaseItem = {
  readonly pk: `release-scope#${string}`;
  readonly sk: string;
  readonly version: number;
  readonly row: ReleaseRow;
};

export type DynamoDBReleaseCatalogItem = {
  readonly pk: "release_catalogs";
  readonly sk: string;
  readonly version: number;
  readonly row: ReleaseCatalogRow;
};

export type DynamoDBItem =
  | DynamoDBBundleItem
  | DynamoDBPatchItem
  | DynamoDBChannelItem
  | DynamoDBReleaseCatalogItem
  | DynamoDBReleaseItem;

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

const isByteSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const withLegacyArchiveByteSize = (value: unknown): unknown =>
  typeof value === "object" &&
  value !== null &&
  field(value, "archive_byte_size") === undefined
    ? { ...value, archive_byte_size: 0 }
    : value;

const isBundleRow = (value: unknown): value is BundleRow =>
  typeof value === "object" &&
  value !== null &&
  typeof field(value, "id") === "string" &&
  (field(value, "platform") === "ios" ||
    field(value, "platform") === "android") &&
  typeof field(value, "file_hash") === "string" &&
  isNullableString(field(value, "git_commit_hash")) &&
  typeof field(value, "storage_uri") === "string" &&
  isByteSize(field(value, "archive_byte_size")) &&
  isDatabaseMetadataObject(field(value, "metadata")) &&
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
  isByteSize(field(value, "byte_size")) &&
  typeof field(value, "order_index") === "number";

const isChannelRow = (value: unknown): value is ChannelRow =>
  typeof value === "object" &&
  value !== null &&
  typeof field(value, "id") === "string" &&
  typeof field(value, "name") === "string";

const isReleaseRow = (value: unknown): value is ReleaseRow =>
  typeof value === "object" &&
  value !== null &&
  typeof field(value, "id") === "string" &&
  typeof field(value, "revision") === "number" &&
  typeof field(value, "scope_key") === "string" &&
  typeof field(value, "channel_id") === "string" &&
  (field(value, "platform") === "ios" ||
    field(value, "platform") === "android") &&
  (field(value, "kind") === "BUNDLE" || field(value, "kind") === "EMBEDDED") &&
  isNullableString(field(value, "bundle_id")) &&
  (field(value, "strategy") === "APP_VERSION" ||
    field(value, "strategy") === "FINGERPRINT") &&
  isNullableString(field(value, "target_app_version")) &&
  isNullableString(field(value, "fingerprint_hash")) &&
  typeof field(value, "enabled") === "boolean" &&
  typeof field(value, "should_force_update") === "boolean" &&
  isNullableString(field(value, "message")) &&
  typeof field(value, "rollout_cohort_count") === "number" &&
  Array.isArray(field(value, "target_cohorts")) &&
  (field(value, "target_cohorts") as unknown[]).every(
    (cohort) => typeof cohort === "string",
  ) &&
  (field(value, "operation") === "DEPLOY" ||
    field(value, "operation") === "PROMOTE" ||
    field(value, "operation") === "ROLLBACK") &&
  isNullableString(field(value, "source_release_id")) &&
  typeof field(value, "created_at_ms") === "number" &&
  typeof field(value, "updated_at_ms") === "number";

const isReleaseCatalogRow = (value: unknown): value is ReleaseCatalogRow =>
  typeof value === "object" &&
  value !== null &&
  typeof field(value, "scope_key") === "string" &&
  typeof field(value, "catalog_id") === "string" &&
  (field(value, "strategy") === "APP_VERSION" ||
    field(value, "strategy") === "FINGERPRINT") &&
  typeof field(value, "channel_id") === "string" &&
  typeof field(value, "channel_key") === "string" &&
  (field(value, "platform") === "ios" ||
    field(value, "platform") === "android") &&
  isNullableString(field(value, "fingerprint_hash")) &&
  typeof field(value, "generation") === "number" &&
  typeof field(value, "payload") === "string" &&
  typeof field(value, "catalog_hash") === "string" &&
  typeof field(value, "byte_size") === "number" &&
  typeof field(value, "is_tombstone") === "boolean" &&
  typeof field(value, "updated_at_ms") === "number";

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
  const row =
    pk === "bundles" ? withLegacyArchiveByteSize(value.row) : value.row;
  if (typeof sk !== "string" || typeof version !== "number") {
    throw new DynamoDBStoredItemError();
  }
  if (
    pk === DYNAMODB_CHANNEL_PARTITION &&
    typeof value.reference_count === "number" &&
    isChannelRow(row)
  ) {
    return { pk, sk, version, reference_count: value.reference_count, row };
  }
  if (
    typeof pk === "string" &&
    pk.startsWith("release-scope#") &&
    isReleaseRow(row)
  ) {
    return { pk: pk as `release-scope#${string}`, sk, version, row };
  }
  if (pk === "release_catalogs" && isReleaseCatalogRow(row)) {
    return { pk, sk, version, row };
  }
  if (typeof gsi1pk !== "string" || typeof gsi1sk !== "string") {
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

export const bundlePlatformPartition = (
  row: Pick<BundleRow, "platform">,
): string => `bundle#${row.platform}`;

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
  gsi1pk: bundlePlatformPartition(row),
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

export const toDynamoDBChannelItem = (
  row: ChannelRow,
  version = 1,
  referenceCount = 0,
): DynamoDBChannelItem => ({
  pk: DYNAMODB_CHANNEL_PARTITION,
  sk: row.id,
  version,
  reference_count: referenceCount,
  row,
});

export const releaseScopePartition = (
  scopeKey: string,
): `release-scope#${string}` => `release-scope#${scopeKey}`;

export const toDynamoDBReleaseItem = (
  row: ReleaseRow,
  version = 1,
): DynamoDBReleaseItem => ({
  pk: releaseScopePartition(row.scope_key),
  sk: row.id,
  version,
  row,
});

export const toDynamoDBReleaseCatalogItem = (
  row: ReleaseCatalogRow,
  version = 1,
): DynamoDBReleaseCatalogItem => ({
  pk: "release_catalogs",
  sk: row.scope_key,
  version,
  row,
});

export const itemKey = (
  model: "bundles" | "bundle_patches" | "channels" | "release_catalogs",
  id: string,
) => ({
  pk: model,
  sk: id,
});

export const exactDynamoDBId = (
  where: readonly object[] | undefined,
): string | undefined => {
  if (where?.length !== 1) return undefined;
  const condition = where[0];
  if (
    Reflect.get(condition, "field") !== "id" ||
    (Reflect.get(condition, "operator") ?? "eq") !== "eq" ||
    Reflect.get(condition, "mode") === "insensitive"
  ) {
    return undefined;
  }
  const value = Reflect.get(condition, "value");
  return typeof value === "string" ? value : undefined;
};

export const exactDynamoDBPatchOwner = (
  where: readonly object[] | undefined,
): string | undefined => {
  const owners = exactDynamoDBPatchOwners(where);
  return owners?.length === 1 ? owners[0] : undefined;
};

export const exactDynamoDBPatchOwners = (
  where: readonly object[] | undefined,
): readonly string[] | undefined => {
  if (
    !where ||
    where.some((condition) => Reflect.get(condition, "connector") === "OR")
  ) {
    return undefined;
  }
  const ownerConditions = where.filter(
    (condition) => Reflect.get(condition, "field") === "bundle_id",
  );
  if (ownerConditions.length !== 1) return undefined;
  const condition = ownerConditions[0];
  if (Reflect.get(condition, "mode") === "insensitive") {
    return undefined;
  }
  const operator = Reflect.get(condition, "operator") ?? "eq";
  const value = Reflect.get(condition, "value");
  if (operator === "eq") {
    return typeof value === "string" ? [value] : undefined;
  }
  if (
    operator === "in" &&
    Array.isArray(value) &&
    value.every((id) => typeof id === "string")
  ) {
    return value;
  }
  return undefined;
};

export const exactDynamoDBBundleIds = (
  where: readonly object[] | undefined,
): readonly string[] | undefined => {
  if (
    !where ||
    where.some((condition) => Reflect.get(condition, "connector") === "OR")
  ) {
    return undefined;
  }
  for (const condition of where) {
    if (
      Reflect.get(condition, "field") !== "id" ||
      Reflect.get(condition, "mode") === "insensitive"
    ) {
      continue;
    }
    const operator = Reflect.get(condition, "operator") ?? "eq";
    const value = Reflect.get(condition, "value");
    if (operator === "eq" && typeof value === "string") return [value];
    if (
      operator === "in" &&
      Array.isArray(value) &&
      value.every((id) => typeof id === "string")
    ) {
      return value;
    }
  }
  return undefined;
};

export const dynamoDBBundlePageStart = (
  where: readonly object[] | undefined,
  direction: "asc" | "desc",
): { readonly id: string; readonly inclusive: boolean } | undefined => {
  if (
    (where ?? []).some(
      (condition) => Reflect.get(condition, "connector") === "OR",
    )
  ) {
    return undefined;
  }
  let result: { readonly id: string; readonly inclusive: boolean } | undefined;
  for (const condition of where ?? []) {
    if (Reflect.get(condition, "field") !== "id") continue;
    const operator = Reflect.get(condition, "operator") ?? "eq";
    const value = Reflect.get(condition, "value");
    const eligible =
      direction === "asc"
        ? operator === "gt" || operator === "gte"
        : operator === "lt" || operator === "lte";
    if (!eligible || typeof value !== "string") continue;
    const inclusive = operator === "gte" || operator === "lte";
    if (
      result === undefined ||
      (direction === "asc" ? value > result.id : value < result.id) ||
      (value === result.id && !inclusive)
    ) {
      result = { id: value, inclusive };
    }
  }
  return result;
};

export type DynamoDBStore = {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
};

const parseStoredItem = (item: Record<string, unknown>): DynamoDBItem =>
  parseDynamoDBItem(
    item.pk === "release_catalogs"
      ? boundedDynamoDBCatalogItem(item)
      : boundedDynamoDBMetadataItem(item),
  );

const queryItems = async (
  store: DynamoDBStore,
  input: {
    readonly partition: string;
    readonly indexName?: string;
    readonly minimumSortKey?: string;
    readonly consistentRead?: boolean;
  },
): Promise<DynamoDBItem[]> => {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const items: DynamoDBItem[] = [];
  do {
    const sortCondition = input.minimumSortKey
      ? " AND #sortKey >= :minimumSortKey"
      : "";
    const page = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        ...(input.indexName ? { IndexName: input.indexName } : {}),
        ...(input.consistentRead ? { ConsistentRead: true } : {}),
        ExclusiveStartKey: exclusiveStartKey,
        KeyConditionExpression: `#partitionKey = :partition${sortCondition}`,
        ExpressionAttributeNames: {
          "#partitionKey": input.indexName ? "gsi1pk" : "pk",
          ...(input.minimumSortKey
            ? { "#sortKey": input.indexName ? "gsi1sk" : "sk" }
            : {}),
        },
        ExpressionAttributeValues: {
          ":partition": input.partition,
          ...(input.minimumSortKey
            ? { ":minimumSortKey": input.minimumSortKey }
            : {}),
        },
      }),
    );
    const pageItems = (page.Items ?? []).map(parseStoredItem);
    items.push(...pageItems);
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
};

export const queryBundleItemsPage = async (
  store: DynamoDBStore,
  input: {
    readonly direction: "asc" | "desc";
    readonly limit: number;
    readonly matches: (row: BundleRow) => boolean;
    readonly start?: { readonly id: string; readonly inclusive: boolean };
  },
): Promise<DynamoDBBundleItem[]> => {
  if (input.limit === 0) return [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const items: DynamoDBBundleItem[] = [];
  do {
    const startOperator = input.start?.inclusive
      ? input.direction === "asc"
        ? ">="
        : "<="
      : input.direction === "asc"
        ? ">"
        : "<";
    const page = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        ExclusiveStartKey: exclusiveStartKey,
        KeyConditionExpression: input.start
          ? `#pk = :pk AND #sk ${startOperator} :start`
          : "#pk = :pk",
        ExpressionAttributeNames: {
          "#pk": "pk",
          ...(input.start ? { "#sk": "sk" } : {}),
        },
        ExpressionAttributeValues: {
          ":pk": "bundles",
          ...(input.start ? { ":start": input.start.id } : {}),
        },
        Limit: Math.max(input.limit - items.length, 100),
        ScanIndexForward: input.direction === "asc",
      }),
    );
    for (const item of (page.Items ?? []).map(parseStoredItem)) {
      if (item.pk === "bundles" && input.matches(item.row)) items.push(item);
      if (items.length === input.limit) return items;
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
};

const loadModelItems = (
  store: DynamoDBStore,
  model: "bundle_patches" | "bundles" | "channels",
): Promise<DynamoDBItem[]> =>
  queryItems(store, { partition: model, consistentRead: true });

const loadModelItem = async (
  store: DynamoDBStore,
  model: "bundle_patches" | "bundles" | "channels",
  id: string,
): Promise<DynamoDBItem | undefined> => {
  const { Item } = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: itemKey(model, id),
      ConsistentRead: true,
    }),
  );
  return Item === undefined ? undefined : parseStoredItem(Item);
};

export const loadBundleItem = async (
  store: DynamoDBStore,
  id: string,
): Promise<DynamoDBBundleItem | undefined> => {
  const item = await loadModelItem(store, "bundles", id);
  return item?.pk === "bundles" ? item : undefined;
};

export const loadPatchItem = async (
  store: DynamoDBStore,
  id: string,
): Promise<DynamoDBPatchItem | undefined> => {
  const item = await loadModelItem(store, "bundle_patches", id);
  return item?.pk === "bundle_patches" ? item : undefined;
};

export const loadChannelItem = async (
  store: DynamoDBStore,
  id: string,
): Promise<DynamoDBChannelItem | undefined> => {
  const item = await loadModelItem(store, DYNAMODB_CHANNEL_PARTITION, id);
  return item?.pk === DYNAMODB_CHANNEL_PARTITION ? item : undefined;
};

export const loadBundleItems = async (
  store: DynamoDBStore,
): Promise<DynamoDBBundleItem[]> => {
  const items = await loadModelItems(store, "bundles");
  return items.filter(
    (item): item is DynamoDBBundleItem => item.pk === "bundles",
  );
};

export const loadPatchItems = async (
  store: DynamoDBStore,
): Promise<DynamoDBPatchItem[]> => {
  const items = await loadModelItems(store, "bundle_patches");
  return items.filter(
    (item): item is DynamoDBPatchItem => item.pk === "bundle_patches",
  );
};

export const loadChannelItems = async (
  store: DynamoDBStore,
): Promise<DynamoDBChannelItem[]> => {
  const items = await loadModelItems(store, DYNAMODB_CHANNEL_PARTITION);
  return items.filter(
    (item): item is DynamoDBChannelItem =>
      item.pk === DYNAMODB_CHANNEL_PARTITION,
  );
};

export const DYNAMODB_RELEASE_ID_PARTITION = "_hot-updater#release-scope-by-id";

const releaseLocatorItem = (row: ReleaseRow): Record<string, unknown> => ({
  pk: DYNAMODB_RELEASE_ID_PARTITION,
  sk: row.id,
  scope_key: row.scope_key,
});

export const loadReleaseItem = async (
  store: DynamoDBStore,
  id: string,
): Promise<DynamoDBReleaseItem | undefined> => {
  const locator = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: { pk: DYNAMODB_RELEASE_ID_PARTITION, sk: id },
      ConsistentRead: true,
    }),
  );
  if (locator.Item === undefined) return undefined;
  const scopeKey = locator.Item.scope_key;
  if (typeof scopeKey !== "string") throw new DynamoDBStoredItemError();
  const result = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: { pk: releaseScopePartition(scopeKey), sk: id },
      ConsistentRead: true,
    }),
  );
  if (result.Item === undefined) throw new DynamoDBStoredItemError();
  const item = parseStoredItem(result.Item);
  if (!isReleaseRow(item.row) || item.sk !== id) {
    throw new DynamoDBStoredItemError();
  }
  return item as DynamoDBReleaseItem;
};

export const loadReleaseItemsByScope = async (
  store: DynamoDBStore,
  scopeKey: string,
): Promise<DynamoDBReleaseItem[]> =>
  (
    await queryItems(store, {
      partition: releaseScopePartition(scopeKey),
      consistentRead: true,
    })
  ).filter(
    (item): item is DynamoDBReleaseItem =>
      item.pk === releaseScopePartition(scopeKey) && isReleaseRow(item.row),
  );

export const loadReleaseItems = async (
  store: DynamoDBStore,
): Promise<DynamoDBReleaseItem[]> => {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const items: DynamoDBReleaseItem[] = [];
  do {
    const page = await store.client.send(
      new ScanCommand({
        TableName: store.tableName,
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
        FilterExpression: "begins_with(#pk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":prefix": "release-scope#" },
      }),
    );
    for (const value of page.Items ?? []) {
      const item = parseStoredItem(value);
      if (isReleaseRow(item.row)) items.push(item as DynamoDBReleaseItem);
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
};

export const loadReleaseCatalogItem = async (
  store: DynamoDBStore,
  scopeKey: string,
): Promise<DynamoDBReleaseCatalogItem | undefined> => {
  const result = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: itemKey("release_catalogs", scopeKey),
      ConsistentRead: true,
    }),
  );
  if (result.Item === undefined) return undefined;
  const item = parseStoredItem(result.Item);
  return item.pk === "release_catalogs" ? item : undefined;
};

export const loadReleaseCatalogItems = async (
  store: DynamoDBStore,
): Promise<DynamoDBReleaseCatalogItem[]> =>
  (
    await queryItems(store, {
      partition: "release_catalogs",
      consistentRead: true,
    })
  ).filter(
    (item): item is DynamoDBReleaseCatalogItem =>
      item.pk === "release_catalogs",
  );

const loadChannelByName = async (
  store: DynamoDBStore,
  name: string,
): Promise<DynamoDBChannelItem | undefined> => {
  const { Item } = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: { pk: DYNAMODB_CHANNEL_NAME_PARTITION, sk: name },
      ConsistentRead: true,
    }),
  );
  const id = Item?.channel_id;
  if (Item === undefined) return undefined;
  if (typeof id !== "string") throw new DynamoDBStoredItemError();
  const channel = await loadChannelItem(store, id);
  if (channel === undefined || channel.row.name !== name) {
    throw new DynamoDBStoredItemError();
  }
  return channel;
};

export const insertDynamoDBChannel = async (
  store: DynamoDBStore,
  input: ChannelInsertInput,
): Promise<ChannelInsertResult> => {
  const existing = await loadChannelByName(store, input.row.name);
  if (existing !== undefined) return { row: existing.row, inserted: false };
  const existingId = await loadChannelItem(store, input.row.id);
  if (existingId !== undefined) {
    if (existingId.row.name === input.row.name) {
      return { row: existingId.row, inserted: false };
    }
    throw new DynamoDBStoredItemError();
  }
  try {
    await commitDynamoDBTransaction(store, [
      {
        Put: {
          TableName: store.tableName,
          Item: boundedDynamoDBMetadataItem(toDynamoDBChannelItem(input.row)),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      },
      {
        Put: {
          TableName: store.tableName,
          Item: {
            pk: DYNAMODB_CHANNEL_NAME_PARTITION,
            sk: input.row.name,
            channel_id: input.row.id,
          },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      },
    ]);
    return { row: input.row, inserted: true };
  } catch (error) {
    const canonical = await loadChannelByName(store, input.row.name);
    if (canonical !== undefined) {
      return { row: canonical.row, inserted: false };
    }
    throw error;
  }
};

export const deleteDynamoDBChannel = async (
  store: DynamoDBStore,
  input: ChannelDeleteInput,
): Promise<ChannelDeleteResult> => {
  const current = await loadChannelItem(store, input.id);
  if (current === undefined) return { deleted: false, reason: "not_found" };
  if (current.reference_count !== 0) {
    return { deleted: false, reason: "not_empty" };
  }
  try {
    await commitDynamoDBTransaction(store, [
      {
        Delete: {
          TableName: store.tableName,
          Key: itemKey(DYNAMODB_CHANNEL_PARTITION, current.sk),
          ConditionExpression:
            "#version = :version AND #referenceCount = :zero",
          ExpressionAttributeNames: {
            "#version": "version",
            "#referenceCount": "reference_count",
          },
          ExpressionAttributeValues: {
            ":version": current.version,
            ":zero": 0,
          },
        },
      },
      {
        Delete: {
          TableName: store.tableName,
          Key: {
            pk: DYNAMODB_CHANNEL_NAME_PARTITION,
            sk: current.row.name,
          },
          ConditionExpression: "#channelId = :channelId",
          ExpressionAttributeNames: { "#channelId": "channel_id" },
          ExpressionAttributeValues: { ":channelId": current.sk },
        },
      },
    ]);
    return { deleted: true };
  } catch (error) {
    const latest = await loadChannelItem(store, input.id);
    if (latest !== undefined && latest.reference_count > 0) {
      return { deleted: false, reason: "not_empty" };
    }
    if (latest === undefined) return { deleted: false, reason: "not_found" };
    throw error;
  }
};

export const queryOwnerPatchIds = async (
  store: DynamoDBStore,
  indexName: string,
  bundleId: string,
): Promise<string[]> => {
  const items = await queryItems(store, {
    partition: patchOwnerPartition(bundleId),
    indexName,
  });
  return items
    .filter((item): item is DynamoDBPatchItem => item.pk === "bundle_patches")
    .map(({ sk }) => sk);
};

export type DynamoDBTransactItem = NonNullable<
  TransactWriteCommandInput["TransactItems"]
>[number];

export class DynamoDBTransactionLimitError extends Error {
  readonly name = "DynamoDBTransactionLimitError";

  constructor(readonly actionCount: number) {
    super(
      `DynamoDB transaction requires ${actionCount} actions; maximum is 100`,
    );
  }
}

type MetadataDelta = {
  readonly bundles?: number;
  readonly bundle_patches?: number;
};

export const metadataUpdate = (
  store: DynamoDBStore,
  delta: MetadataDelta,
): DynamoDBTransactItem | undefined => {
  const entries = Object.entries(delta).filter(([, value]) => value !== 0) as [
    keyof MetadataDelta,
    number,
  ][];
  if (entries.length === 0) return undefined;

  const names: Record<string, string> = {};
  const values: Record<string, number> = {};
  const updates: string[] = [];
  const conditions: string[] = [];
  for (const [model, change] of entries) {
    const name = model === "bundles" ? "bundles" : "patches";
    const valueName = model === "bundles" ? "bundle" : "patch";
    names[`#${name}`] = name;
    values[`:${valueName}Delta`] = change;
    updates.push(`#${name} :${valueName}Delta`);
    if (change < 0) {
      values[`:${valueName}Removal`] = -change;
      conditions.push(`#${name} >= :${valueName}Removal`);
    }
  }

  return {
    Update: {
      TableName: store.tableName,
      Key: { pk: "_hot-updater", sk: "limits.metadata" },
      UpdateExpression: `ADD ${updates.join(", ")}`,
      ...(conditions.length > 0
        ? { ConditionExpression: conditions.join(" AND ") }
        : {}),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
};

export const updateBundleRelation = (
  store: DynamoDBStore,
  bundleId: string,
  delta: number,
  ownedPatchDelta = 0,
): DynamoDBTransactItem => {
  const names: Record<string, string> = {
    "#pk": "pk",
    "#version": "version",
  };
  const values: Record<string, number> = { ":one": 1 };
  const additions: string[] = [];
  let condition = "attribute_exists(#pk)";
  let update = "SET #version = #version + :one";
  if (delta !== 0) {
    names["#relationCount"] = "relation_count";
    values[":relationDelta"] = delta;
    additions.push("#relationCount :relationDelta");
    if (delta < 0) {
      values[":relationRemoval"] = -delta;
      condition += " AND #relationCount >= :relationRemoval";
    }
  }
  if (ownedPatchDelta !== 0) {
    names["#ownedPatchCount"] = "owned_patch_count";
    values[":ownedPatchDelta"] = ownedPatchDelta;
    additions.push("#ownedPatchCount :ownedPatchDelta");
    if (ownedPatchDelta < 0) {
      values[":ownedPatchRemoval"] = -ownedPatchDelta;
      condition += " AND #ownedPatchCount >= :ownedPatchRemoval";
    }
  }
  if (additions.length > 0) update += ` ADD ${additions.join(", ")}`;
  return {
    Update: {
      TableName: store.tableName,
      Key: itemKey("bundles", bundleId),
      ConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      UpdateExpression: update,
    },
  };
};

export const commitDynamoDBTransaction = async (
  store: DynamoDBStore,
  actions: readonly DynamoDBTransactItem[],
): Promise<void> => {
  if (actions.length > 100) {
    throw new DynamoDBTransactionLimitError(actions.length);
  }
  await store.client.send(
    new TransactWriteCommand({ TransactItems: [...actions] }),
  );
};

const DYNAMODB_BATCH_GET_ATTEMPTS = 5;

const DYNAMODB_BATCH_GET_BASE_DELAY_MS = 25;

export class DynamoDBBatchGetExhaustedError extends Error {
  readonly name = "DynamoDBBatchGetExhaustedError";

  constructor(readonly unprocessedKeyCount: number) {
    super(
      `DynamoDB did not process ${unprocessedKeyCount} batch-get keys after ${DYNAMODB_BATCH_GET_ATTEMPTS} attempts`,
    );
  }
}

const waitBeforeRetry = (attempt: number): Promise<void> =>
  new Promise((resolve) =>
    setTimeout(resolve, DYNAMODB_BATCH_GET_BASE_DELAY_MS * 2 ** attempt),
  );

export const batchGetDynamoDBItems = async (
  store: DynamoDBStore,
  keys: readonly Record<string, NativeAttributeValue>[],
): Promise<Record<string, NativeAttributeValue>[]> => {
  const items: Record<string, NativeAttributeValue>[] = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    let pending = keys.slice(offset, offset + 100);
    for (
      let attempt = 0;
      attempt < DYNAMODB_BATCH_GET_ATTEMPTS && pending.length > 0;
      attempt++
    ) {
      const { Responses, UnprocessedKeys } = await store.client.send(
        new BatchGetCommand({
          RequestItems: {
            [store.tableName]: { ConsistentRead: true, Keys: pending },
          },
        }),
      );
      items.push(...(Responses?.[store.tableName] ?? []));
      pending = UnprocessedKeys?.[store.tableName]?.Keys ?? [];
      if (pending.length > 0 && attempt + 1 < DYNAMODB_BATCH_GET_ATTEMPTS) {
        await waitBeforeRetry(attempt);
      }
    }
    if (pending.length > 0) {
      throw new DynamoDBBatchGetExhaustedError(pending.length);
    }
  }
  return items;
};

const parseKeyReadItem = (item: Record<string, unknown>) =>
  parseDynamoDBItem(boundedDynamoDBMetadataItem(item));

export const loadBundleItemsById = async (
  store: DynamoDBStore,
  ids: readonly string[],
): Promise<DynamoDBBundleItem[]> => {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  return (
    await batchGetDynamoDBItems(
      store,
      uniqueIds.map((id) => itemKey("bundles", id)),
    )
  )
    .map(parseKeyReadItem)
    .filter((item): item is DynamoDBBundleItem => item.pk === "bundles");
};

export const loadPatchItemsById = async (
  store: DynamoDBStore,
  ids: readonly string[],
): Promise<DynamoDBPatchItem[]> => {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  return (
    await batchGetDynamoDBItems(
      store,
      uniqueIds.map((id) => itemKey("bundle_patches", id)),
    )
  )
    .map(parseKeyReadItem)
    .filter((item): item is DynamoDBPatchItem => item.pk === "bundle_patches");
};

export const loadMetadataCount = async (
  store: DynamoDBStore,
  model: DatabaseModel,
): Promise<number | undefined> => {
  if (model !== "bundles" && model !== "bundle_patches") return undefined;
  const field = model === "bundles" ? "bundles" : "patches";
  const { Item } = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: { pk: "_hot-updater", sk: "limits.metadata" },
      ConsistentRead: true,
      ProjectionExpression: "#count",
      ExpressionAttributeNames: { "#count": field },
    }),
  );
  const count = Item?.[field];
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? count
    : undefined;
};

export class DynamoDBPatchIndexConsistencyError extends Error {
  readonly name = "DynamoDBPatchIndexConsistencyError";

  constructor(
    readonly bundleId: string,
    readonly expectedCount: number,
  ) {
    super(
      `DynamoDB patch index did not converge to ${expectedCount} rows for bundle "${bundleId}"`,
    );
  }
}

const waitForIndex = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));

export const queryCompleteOwnerPatches = async (
  store: DynamoDBStore,
  indexName: string,
  bundleId: string,
): Promise<BundlePatchRow[]> => {
  const owner = await loadBundleItem(store, bundleId);
  if (!owner || owner.owned_patch_count === 0) return [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const patchIds = await queryOwnerPatchIds(store, indexName, bundleId);
    const patchIdSet = new Set(patchIds);
    const patches = (await loadPatchItemsById(store, patchIds)).filter(
      ({ row }) => row.bundle_id === bundleId,
    );
    if (
      patchIds.length === owner.owned_patch_count &&
      patchIdSet.size === owner.owned_patch_count &&
      patches.length === owner.owned_patch_count &&
      patches.every(({ sk }) => patchIdSet.has(sk))
    ) {
      return patches
        .map(({ row }) => row)
        .sort(
          (left, right) =>
            left.order_index - right.order_index ||
            left.id.localeCompare(right.id),
        );
    }
    if (attempt < 2) await waitForIndex(attempt);
  }
  throw new DynamoDBPatchIndexConsistencyError(
    bundleId,
    owner.owned_patch_count,
  );
};

export const queryCompleteOwnersPatches = async (
  store: DynamoDBStore,
  indexName: string,
  bundleIds: readonly string[],
): Promise<BundlePatchRow[]> => {
  const owners = (await loadBundleItemsById(store, bundleIds)).filter(
    ({ owned_patch_count }) => owned_patch_count > 0,
  );
  const firstOwner = owners[0];
  if (!firstOwner) return [];
  let failedOwner = firstOwner;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidateIdsByOwner = await Promise.all(
      owners.map(({ sk }) => queryOwnerPatchIds(store, indexName, sk)),
    );
    const candidateIds = candidateIdsByOwner.flat();
    const patches = await loadPatchItemsById(store, candidateIds);
    const patchesById = new Map(patches.map((patch) => [patch.sk, patch]));
    const mismatchedOwner = owners.find((owner, ownerIndex) => {
      const ids = candidateIdsByOwner[ownerIndex] ?? [];
      const uniqueIds = new Set(ids);
      return (
        ids.length !== owner.owned_patch_count ||
        uniqueIds.size !== owner.owned_patch_count ||
        ids.some((id) => patchesById.get(id)?.row.bundle_id !== owner.sk)
      );
    });
    if (!mismatchedOwner) return patches.map(({ row }) => row);
    failedOwner = mismatchedOwner;
    if (attempt < 2) await waitForIndex(attempt);
  }
  throw new DynamoDBPatchIndexConsistencyError(
    failedOwner.sk,
    failedOwner.owned_patch_count,
  );
};

const createDynamoDBBundlePatchTable = (
  store: DynamoDBStore,
  indexName: string,
): import("@hot-updater/plugin-core").BundlePatchModel => ({
  findByBundleIds: (bundleIds) =>
    bundleIds.length === 0
      ? Promise.resolve([])
      : queryCompleteOwnersPatches(store, indexName, bundleIds),
});

const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (left == null) return right == null ? 0 : -1;
  if (right == null) return 1;
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
};

const compareString = (
  actual: unknown,
  expected: string,
  mode: unknown,
  predicate: (value: string, query: string) => boolean,
): boolean => {
  if (typeof actual !== "string") return false;
  return mode === "insensitive"
    ? predicate(actual.toLocaleLowerCase(), expected.toLocaleLowerCase())
    : predicate(actual, expected);
};

const matchesCondition = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  condition: DatabaseWhere<TModel>,
): boolean => {
  const actual = Reflect.get(row, condition.field);
  const expected = Reflect.get(condition, "value");
  const operator = Reflect.get(condition, "operator") ?? "eq";
  switch (operator) {
    case "eq":
      return typeof expected === "string"
        ? compareString(
            actual,
            expected,
            Reflect.get(condition, "mode"),
            (value, query) => value === query,
          )
        : actual === expected;
    case "ne":
      if (actual == null) return false;
      return typeof expected === "string"
        ? !compareString(
            actual,
            expected,
            Reflect.get(condition, "mode"),
            (value, query) => value === query,
          )
        : actual !== expected;
    case "gt":
      return actual != null && compare(actual, expected) > 0;
    case "gte":
      return actual != null && compare(actual, expected) >= 0;
    case "lt":
      return actual != null && compare(actual, expected) < 0;
    case "lte":
      return actual != null && compare(actual, expected) <= 0;
    case "in":
      return (
        Array.isArray(expected) &&
        expected.some((candidate: unknown) => candidate === actual)
      );
    case "not_in":
      return (
        Array.isArray(expected) &&
        (expected.length === 0 ||
          (actual != null &&
            expected.every((candidate: unknown) => candidate !== actual)))
      );
    case "contains":
      return typeof expected === "string"
        ? compareString(
            actual,
            expected,
            Reflect.get(condition, "mode"),
            (value, query) => value.includes(query),
          )
        : false;
    case "starts_with":
      return typeof expected === "string"
        ? compareString(
            actual,
            expected,
            Reflect.get(condition, "mode"),
            (value, query) => value.startsWith(query),
          )
        : false;
    case "ends_with":
      return typeof expected === "string"
        ? compareString(
            actual,
            expected,
            Reflect.get(condition, "mode"),
            (value, query) => value.endsWith(query),
          )
        : false;
    default:
      return false;
  }
};

export const matchesDynamoDBWhere = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  where: readonly DatabaseWhere<TModel>[] | undefined,
): boolean => {
  if (!where || where.length === 0) return true;
  let result = matchesCondition(row, where[0]);
  for (const condition of where.slice(1)) {
    const current = matchesCondition(row, condition);
    result =
      condition.connector === "OR" ? result || current : result && current;
  }
  return result;
};

const compareRows = <TModel extends DatabaseModel>(
  left: DatabaseRow<TModel>,
  right: DatabaseRow<TModel>,
  orderBy: DatabaseOrderBy<TModel>,
): number => {
  for (const clause of orderBy) {
    const leftValue = Reflect.get(left, clause.field);
    const rightValue = Reflect.get(right, clause.field);
    if (leftValue == null || rightValue == null) {
      if (leftValue == null && rightValue == null) continue;
      const nulls =
        clause.nulls ?? (clause.direction === "asc" ? "last" : "first");
      const order = leftValue == null ? -1 : 1;
      return nulls === "first" ? order : -order;
    }
    const order = compare(leftValue, rightValue);
    if (order !== 0) return clause.direction === "asc" ? order : -order;
  }
  return 0;
};

const distinctKey = <TModel extends DatabaseModel>(
  row: DatabaseRow<TModel>,
  distinctOn: DatabaseDistinctOn<TModel>,
): string =>
  JSON.stringify(distinctOn.fields.map((field) => Reflect.get(row, field)));

export const queryDynamoDBRows = <TModel extends DatabaseModel>(
  rows: readonly DatabaseRow<TModel>[],
  input: {
    readonly where?: readonly DatabaseWhere<TModel>[];
    readonly orderBy?: DatabaseOrderBy<TModel>;
    readonly distinctOn?: DatabaseDistinctOn<TModel>;
    readonly offset?: number;
    readonly limit?: number;
  },
): DatabaseRow<TModel>[] => {
  const filtered = rows.filter((row) => matchesDynamoDBWhere(row, input.where));
  const orderBy = input.orderBy;
  const ordered = orderBy
    ? filtered.toSorted((left, right) => compareRows(left, right, orderBy))
    : filtered;
  const distinctOn = input.distinctOn;
  const distinct = distinctOn
    ? (() => {
        const seen = new Set<string>();
        return ordered.filter((row) => {
          const key = distinctKey(row, distinctOn);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      })()
    : ordered;
  const offset = input.offset ?? 0;
  return distinct.slice(offset, offset + (input.limit ?? 100));
};

export const countDistinctDynamoDBRows = <TModel extends DatabaseModel>(
  rows: readonly DatabaseRow<TModel>[],
  fields: readonly string[] | undefined,
): number => {
  if (fields === undefined) return rows.length;
  return new Set(
    rows.map((row) =>
      JSON.stringify(fields.map((field) => Reflect.get(row, field))),
    ),
  ).size;
};

export const createDynamoDBBundle = async (
  store: DynamoDBStore,
  row: BundleRow,
): Promise<void> => {
  const counter = metadataUpdate(store, { bundles: 1 });
  if (!counter) return;
  await commitDynamoDBTransaction(store, [
    counter,
    {
      Put: {
        TableName: store.tableName,
        Item: boundedDynamoDBMetadataItem(toDynamoDBBundleItem(row)),
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" },
      },
    },
  ]);
};

export const createDynamoDBPatch = async (
  store: DynamoDBStore,
  row: BundlePatchRow,
): Promise<void> => {
  const bundleIds = [...new Set([row.bundle_id, row.base_bundle_id])];
  const counter = metadataUpdate(store, { bundle_patches: 1 });
  if (!counter) return;
  await commitDynamoDBTransaction(store, [
    counter,
    ...bundleIds.map((bundleId) =>
      updateBundleRelation(
        store,
        bundleId,
        1,
        bundleId === row.bundle_id ? 1 : 0,
      ),
    ),
    {
      Put: {
        TableName: store.tableName,
        Item: boundedDynamoDBMetadataItem(toDynamoDBPatchItem(row)),
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" },
      },
    },
  ]);
};

export const replaceDynamoDBBundle = async (
  store: DynamoDBStore,
  current: DynamoDBBundleItem,
  row: BundleRow,
): Promise<void> => {
  await store.client.send(
    new PutCommand({
      TableName: store.tableName,
      Item: boundedDynamoDBMetadataItem(
        toDynamoDBBundleItem(
          row,
          current.version + 1,
          current.relation_count,
          current.owned_patch_count,
        ),
      ),
      ConditionExpression: "#version = :currentVersion",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":currentVersion": current.version },
    }),
  );
};

const deleteAction = (
  store: DynamoDBStore,
  item: DynamoDBItem,
): DynamoDBTransactItem => ({
  Delete: {
    TableName: store.tableName,
    Key: { pk: item.pk, sk: item.sk },
    ConditionExpression: "#version = :currentVersion",
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: { ":currentVersion": item.version },
  },
});

export const deleteDynamoDBPatch = async (
  store: DynamoDBStore,
  item: DynamoDBPatchItem,
): Promise<void> => {
  const counter = metadataUpdate(store, { bundle_patches: -1 });
  if (!counter) return;
  const bundleIds = [...new Set([item.row.bundle_id, item.row.base_bundle_id])];
  await commitDynamoDBTransaction(store, [
    counter,
    ...bundleIds.map((id) =>
      updateBundleRelation(store, id, -1, id === item.row.bundle_id ? -1 : 0),
    ),
    deleteAction(store, item),
  ]);
};

const deleteBundle = async (
  store: DynamoDBStore,
  bundle: DynamoDBBundleItem,
  patches: readonly DynamoDBPatchItem[],
): Promise<void> => {
  const counter = metadataUpdate(store, {
    bundles: -1,
    bundle_patches: -patches.length,
  });
  if (!counter) return;
  const otherEndpointCounts = new Map<
    string,
    { readonly owned: number; readonly relations: number }
  >();
  for (const { row } of patches) {
    for (const id of new Set([row.bundle_id, row.base_bundle_id])) {
      if (id === bundle.sk) continue;
      const current = otherEndpointCounts.get(id) ?? {
        owned: 0,
        relations: 0,
      };
      otherEndpointCounts.set(id, {
        owned: current.owned + (id === row.bundle_id ? 1 : 0),
        relations: current.relations + 1,
      });
    }
  }
  await commitDynamoDBTransaction(store, [
    counter,
    ...[...otherEndpointCounts].map(([id, count]) =>
      updateBundleRelation(store, id, -count.relations, -count.owned),
    ),
    ...patches.map((patch) => deleteAction(store, patch)),
    deleteAction(store, bundle),
  ]);
};

export const deleteDynamoDBBundles = async (
  store: DynamoDBStore,
  bundles: readonly DynamoDBBundleItem[],
  allPatches: readonly DynamoDBPatchItem[],
): Promise<void> => {
  let patches = [...allPatches];
  const versionIncrements = new Map<string, number>();
  for (const originalBundle of bundles) {
    const bundle = {
      ...originalBundle,
      version:
        originalBundle.version +
        (versionIncrements.get(originalBundle.sk) ?? 0),
    };
    const related = patches.filter(
      ({ row }) =>
        row.bundle_id === bundle.sk || row.base_bundle_id === bundle.sk,
    );
    await deleteBundle(store, bundle, related);
    const updatedBundleIds = new Set(
      related.flatMap(({ row }) => [row.bundle_id, row.base_bundle_id]),
    );
    updatedBundleIds.delete(bundle.sk);
    for (const id of updatedBundleIds) {
      versionIncrements.set(id, (versionIncrements.get(id) ?? 0) + 1);
    }
    const removedPatchIds = new Set(related.map(({ sk }) => sk));
    patches = patches.filter(({ sk }) => !removedPatchIds.has(sk));
  }
};

class DynamoDBUnsupportedModelError extends Error {
  readonly name = "DynamoDBUnsupportedModelError";

  constructor() {
    super("DynamoDB received an unsupported database model");
  }
}

const distinctFields = (
  fields: readonly string[] | undefined,
): readonly string[] | undefined => fields;

const exactDynamoDBField = (
  where: readonly object[] | undefined,
  fieldName: string,
): string | undefined => {
  const conditions = (where ?? []).filter(
    (condition) => Reflect.get(condition, "field") === fieldName,
  );
  if (conditions.length !== 1) return undefined;
  const condition = conditions[0];
  if (
    (Reflect.get(condition, "operator") ?? "eq") !== "eq" ||
    Reflect.get(condition, "mode") === "insensitive"
  ) {
    return undefined;
  }
  const value = Reflect.get(condition, "value");
  return typeof value === "string" ? value : undefined;
};

export const createDynamoDBCrud = (
  store: DynamoDBStore,
  updateIndexName: string,
  insights: InsightsModel,
): DatabasePluginImplementation => ({
  insights,
  async create(input): Promise<DatabaseImplementationResult> {
    switch (input.model) {
      case "bundles":
        await createDynamoDBBundle(store, input.data);
        return input.data;
      case "bundle_patches":
        await createDynamoDBPatch(store, input.data);
        return input.data;
      case "releases": {
        const channel = await loadChannelItem(store, input.data.channel_id);
        if (channel === undefined) throw new DynamoDBStoredItemError();
        await commitDynamoDBTransaction(store, [
          updateChannelReferenceCount(store, channel, 1),
          {
            Put: {
              TableName: store.tableName,
              Item: boundedDynamoDBMetadataItem(
                toDynamoDBReleaseItem(input.data),
              ),
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" },
            },
          },
          {
            Put: {
              TableName: store.tableName,
              Item: releaseLocatorItem(input.data),
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" },
            },
          },
        ]);
        return input.data;
      }
      case "release_catalogs":
        await store.client.send(
          new PutCommand({
            TableName: store.tableName,
            Item: boundedDynamoDBCatalogItem(
              toDynamoDBReleaseCatalogItem(input.data),
            ),
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
          }),
        );
        return input.data;
      case "channels":
        return (
          await insertDynamoDBChannel(store, {
            row: input.data,
            onConflict: "returnExisting",
          })
        ).row;
    }
    throw new DynamoDBUnsupportedModelError();
  },
  async update(input): Promise<DatabaseImplementationResult | null> {
    if (input.model === "releases") {
      const id = exactDynamoDBId(input.where);
      if (id === undefined) throw new DynamoDBUnsupportedModelError();
      const current = await loadReleaseItem(store, id);
      if (current === undefined) return null;
      const updated = { ...current.row, ...input.update };
      const nextPartition = releaseScopePartition(updated.scope_key);
      const moved = current.pk !== nextPartition;
      await commitDynamoDBTransaction(store, [
        ...(moved
          ? [
              {
                Delete: {
                  TableName: store.tableName,
                  Key: { pk: current.pk, sk: current.sk },
                  ConditionExpression: "#version = :version",
                  ExpressionAttributeNames: { "#version": "version" },
                  ExpressionAttributeValues: { ":version": current.version },
                },
              } satisfies DynamoDBTransactItem,
            ]
          : []),
        {
          Put: {
            TableName: store.tableName,
            Item: boundedDynamoDBMetadataItem(
              toDynamoDBReleaseItem(updated, current.version + 1),
            ),
            ConditionExpression: moved
              ? "attribute_not_exists(#pk)"
              : "#version = :version",
            ExpressionAttributeNames: moved
              ? { "#pk": "pk" }
              : { "#version": "version" },
            ...(moved
              ? {}
              : {
                  ExpressionAttributeValues: { ":version": current.version },
                }),
          },
        },
        {
          Put: {
            TableName: store.tableName,
            Item: releaseLocatorItem(updated),
            ConditionExpression: "#scopeKey = :scopeKey",
            ExpressionAttributeNames: { "#scopeKey": "scope_key" },
            ExpressionAttributeValues: {
              ":scopeKey": current.row.scope_key,
            },
          },
        },
      ]);
      return updated;
    }
    if (input.model === "release_catalogs") {
      const scopeKey = exactDynamoDBField(input.where, "scope_key");
      if (scopeKey === undefined) throw new DynamoDBUnsupportedModelError();
      const current = await loadReleaseCatalogItem(store, scopeKey);
      if (current === undefined) return null;
      const updated = { ...current.row, ...input.update };
      await store.client.send(
        new PutCommand({
          TableName: store.tableName,
          Item: boundedDynamoDBCatalogItem(
            toDynamoDBReleaseCatalogItem(updated, current.version + 1),
          ),
          ConditionExpression: "#version = :version",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: { ":version": current.version },
        }),
      );
      return updated;
    }
    if (input.model !== "bundles") {
      throw new DynamoDBUnsupportedModelError();
    }
    const id = exactDynamoDBId(input.where);
    const current =
      id === undefined
        ? (await loadBundleItems(store)).find(({ row }) =>
            matchesDynamoDBWhere(row, input.where),
          )
        : await loadBundleItem(store, id);
    if (!current) return null;
    const updated = { ...current.row, ...input.update };
    await replaceDynamoDBBundle(store, current, updated);
    return updated;
  },
  async delete(input): Promise<void> {
    if (input.model === "channels") {
      const id = exactDynamoDBId(input.where);
      if (id !== undefined) await deleteDynamoDBChannel(store, { id });
      return;
    }
    if (input.model === "bundle_patches") {
      const items = (await loadPatchItems(store)).filter(({ row }) =>
        matchesDynamoDBWhere(row, input.where),
      );
      for (const item of items) await deleteDynamoDBPatch(store, item);
      return;
    }
    if (input.model === "releases") {
      const items = (await loadReleaseItems(store)).filter(({ row }) =>
        matchesDynamoDBWhere(row, input.where),
      );
      for (const item of items) {
        const channel = await loadChannelItem(store, item.row.channel_id);
        if (channel === undefined) throw new DynamoDBStoredItemError();
        await commitDynamoDBTransaction(store, [
          updateChannelReferenceCount(store, channel, -1),
          deleteAction(store, item),
          {
            Delete: {
              TableName: store.tableName,
              Key: { pk: DYNAMODB_RELEASE_ID_PARTITION, sk: item.sk },
              ConditionExpression: "#scopeKey = :scopeKey",
              ExpressionAttributeNames: { "#scopeKey": "scope_key" },
              ExpressionAttributeValues: { ":scopeKey": item.row.scope_key },
            },
          },
        ]);
      }
      return;
    }
    if (input.model !== "bundles") {
      throw new DynamoDBUnsupportedModelError();
    }
    const bundleItems = (await loadBundleItems(store)).filter(({ row }) =>
      matchesDynamoDBWhere(row, input.where),
    );
    if (bundleItems.length === 0) return;
    await deleteDynamoDBBundles(
      store,
      bundleItems,
      await loadPatchItems(store),
    );
  },
  async count(input): Promise<number> {
    if (
      (input.where === undefined || input.where.length === 0) &&
      input.distinct === undefined
    ) {
      const count = await loadMetadataCount(store, input.model);
      if (count !== undefined) return count;
    }
    switch (input.model) {
      case "bundles": {
        const rows = (await loadBundleItems(store))
          .map(({ row }) => row)
          .filter((row) => matchesDynamoDBWhere(row, input.where));
        return countDistinctDynamoDBRows(rows, distinctFields(input.distinct));
      }
      case "bundle_patches": {
        const ownerId = exactDynamoDBPatchOwner(input.where);
        const rows = (
          ownerId
            ? await queryCompleteOwnerPatches(store, updateIndexName, ownerId)
            : (await loadPatchItems(store)).map(({ row }) => row)
        ).filter((row) => matchesDynamoDBWhere(row, input.where));
        return countDistinctDynamoDBRows(rows, distinctFields(input.distinct));
      }
      case "releases": {
        const scopeKey = exactDynamoDBField(input.where, "scope_key");
        const rows = (
          scopeKey === undefined
            ? await loadReleaseItems(store)
            : await loadReleaseItemsByScope(store, scopeKey)
        )
          .map(({ row }) => row)
          .filter((row) => matchesDynamoDBWhere(row, input.where));
        return countDistinctDynamoDBRows(rows, distinctFields(input.distinct));
      }
    }
    throw new DynamoDBUnsupportedModelError();
  },
  async findOne(input): Promise<DatabaseImplementationResult | null> {
    const id = exactDynamoDBId(input.where);
    switch (input.model) {
      case "bundles":
        if (id !== undefined)
          return (await loadBundleItem(store, id))?.row ?? null;
        return (
          (await loadBundleItems(store))
            .map(({ row }) => row)
            .find((row) => matchesDynamoDBWhere(row, input.where)) ?? null
        );
      case "bundle_patches":
        if (id !== undefined)
          return (await loadPatchItem(store, id))?.row ?? null;
        {
          const ownerId = exactDynamoDBPatchOwner(input.where);
          if (ownerId === undefined) break;
          return (
            (
              await queryCompleteOwnerPatches(store, updateIndexName, ownerId)
            ).find((row) => matchesDynamoDBWhere(row, input.where)) ?? null
          );
        }
        break;
      case "channels":
        if (id !== undefined)
          return (await loadChannelItem(store, id))?.row ?? null;
        return (
          (await loadChannelItems(store))
            .map(({ row }) => row)
            .find((row) => matchesDynamoDBWhere(row, input.where)) ?? null
        );
      case "releases":
        if (id !== undefined)
          return (await loadReleaseItem(store, id))?.row ?? null;
        {
          const scopeKey = exactDynamoDBField(input.where, "scope_key");
          return (
            (scopeKey === undefined
              ? await loadReleaseItems(store)
              : await loadReleaseItemsByScope(store, scopeKey)
            )
              .map(({ row }) => row)
              .find((row) => matchesDynamoDBWhere(row, input.where)) ?? null
          );
        }
      case "release_catalogs": {
        const scopeKey = exactDynamoDBField(input.where, "scope_key");
        if (scopeKey !== undefined) {
          return (await loadReleaseCatalogItem(store, scopeKey))?.row ?? null;
        }
        return (
          (await loadReleaseCatalogItems(store))
            .map(({ row }) => row)
            .find((row) => matchesDynamoDBWhere(row, input.where)) ?? null
        );
      }
    }
    if (input.model === "bundle_patches") {
      return (
        (await loadPatchItems(store))
          .map(({ row }) => row)
          .find((row) => matchesDynamoDBWhere(row, input.where)) ?? null
      );
    }
    throw new DynamoDBUnsupportedModelError();
  },
  async findMany(input): Promise<readonly DatabaseImplementationResult[]> {
    if (input.limit === 0) return [];
    switch (input.model) {
      case "bundles": {
        const ids = exactDynamoDBBundleIds(input.where);
        if (ids !== undefined) {
          return queryDynamoDBRows(
            (await loadBundleItemsById(store, ids)).map(({ row }) => row),
            input,
          );
        }
        const orderBy = input.orderBy;
        const direction = orderBy?.[0]?.direction;
        if (
          (input.offset ?? 0) === 0 &&
          input.distinctOn === undefined &&
          orderBy?.length === 1 &&
          orderBy[0]?.field === "id" &&
          (direction === "asc" || direction === "desc")
        ) {
          return (
            await queryBundleItemsPage(store, {
              direction,
              limit: input.limit ?? 100,
              matches: (row) => matchesDynamoDBWhere(row, input.where),
              start: dynamoDBBundlePageStart(input.where, direction),
            })
          ).map(({ row }) => row);
        }
        return queryDynamoDBRows(
          (await loadBundleItems(store)).map(({ row }) => row),
          input,
        );
      }
      case "bundle_patches": {
        const ownerIds = exactDynamoDBPatchOwners(input.where);
        if (ownerIds !== undefined) {
          const ownerId = ownerIds.length === 1 ? ownerIds[0] : undefined;
          return queryDynamoDBRows(
            ownerId !== undefined
              ? await queryCompleteOwnerPatches(store, updateIndexName, ownerId)
              : await queryCompleteOwnersPatches(
                  store,
                  updateIndexName,
                  ownerIds,
                ),
            input,
          );
        }
        return queryDynamoDBRows(
          (await loadPatchItems(store)).map(({ row }) => row),
          input,
        );
      }
      case "channels":
        return queryDynamoDBRows(
          (await loadChannelItems(store)).map(({ row }) => row),
          input,
        );
      case "releases": {
        const scopeKey = exactDynamoDBField(input.where, "scope_key");
        return queryDynamoDBRows(
          (scopeKey === undefined
            ? await loadReleaseItems(store)
            : await loadReleaseItemsByScope(store, scopeKey)
          ).map(({ row }) => row),
          input,
        );
      }
      case "release_catalogs":
        return queryDynamoDBRows(
          (await loadReleaseCatalogItems(store)).map(({ row }) => row),
          input,
        );
    }
    throw new DynamoDBUnsupportedModelError();
  },
  insertChannel: (input) => insertDynamoDBChannel(store, input),
  deleteChannel: (input) => deleteDynamoDBChannel(store, input),
});

class DynamoDBDuplicatePatchError extends Error {
  readonly name = "DynamoDBDuplicatePatchError";

  constructor(readonly patchId: string) {
    super(`DynamoDB bundle mutation contains duplicate patch "${patchId}"`);
  }
}

const assertUniquePatches = (patches: readonly BundlePatchRow[]): void => {
  const seen = new Set<string>();
  for (const patch of patches) {
    if (seen.has(patch.id)) throw new DynamoDBDuplicatePatchError(patch.id);
    seen.add(patch.id);
  }
};

const putNewBundle = (
  store: DynamoDBStore,
  row: BundleRow,
  relationCount: number,
  ownedPatchCount = relationCount,
): DynamoDBTransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: boundedDynamoDBMetadataItem(
      toDynamoDBBundleItem(row, 1, relationCount, ownedPatchCount),
    ),
    ConditionExpression: "attribute_not_exists(#pk)",
    ExpressionAttributeNames: { "#pk": "pk" },
  },
});

const putUpdatedBundle = (
  store: DynamoDBStore,
  current: DynamoDBBundleItem,
  row: BundleRow,
  relationCount: number,
  ownedPatchCount: number,
): DynamoDBTransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: boundedDynamoDBMetadataItem(
      toDynamoDBBundleItem(
        row,
        current.version + 1,
        relationCount,
        ownedPatchCount,
      ),
    ),
    ConditionExpression: "#version = :currentVersion",
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: { ":currentVersion": current.version },
  },
});

const putPatch = (
  store: DynamoDBStore,
  row: BundlePatchRow,
  current: DynamoDBPatchItem | undefined,
): DynamoDBTransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: boundedDynamoDBMetadataItem(
      toDynamoDBPatchItem(row, (current?.version ?? 0) + 1),
    ),
    ConditionExpression: current
      ? "#version = :currentVersion"
      : "attribute_not_exists(#pk)",
    ExpressionAttributeNames: current
      ? { "#version": "version" }
      : { "#pk": "pk" },
    ...(current
      ? { ExpressionAttributeValues: { ":currentVersion": current.version } }
      : {}),
  },
});

const deletePatch = (
  store: DynamoDBStore,
  item: DynamoDBPatchItem,
): DynamoDBTransactItem => ({
  Delete: {
    TableName: store.tableName,
    Key: itemKey(item.pk, item.sk),
    ConditionExpression: "#version = :currentVersion",
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: { ":currentVersion": item.version },
  },
});

const baseReferenceChanges = (
  store: DynamoDBStore,
  ownerBundleId: string,
  current: readonly BundlePatchRow[],
  next: readonly BundlePatchRow[],
): DynamoDBTransactItem[] => {
  const changes = new Map<string, number>();
  for (const patch of current) {
    if (patch.base_bundle_id !== ownerBundleId) {
      changes.set(
        patch.base_bundle_id,
        (changes.get(patch.base_bundle_id) ?? 0) - 1,
      );
    }
  }
  for (const patch of next) {
    if (patch.base_bundle_id !== ownerBundleId) {
      changes.set(
        patch.base_bundle_id,
        (changes.get(patch.base_bundle_id) ?? 0) + 1,
      );
    }
  }
  return [...changes]
    .filter(([, delta]) => delta !== 0)
    .map(([baseBundleId, delta]) =>
      updateBundleRelation(store, baseBundleId, delta),
    );
};

interface DynamoDBAggregateMutations {
  insertBundleWithPatches(input: {
    readonly bundle: BundleRow;
    readonly patches: readonly BundlePatchRow[];
  }): Promise<void>;
  updateBundleWithPatches(input: {
    readonly bundleId: string;
    readonly update: Partial<Omit<BundleRow, "id">>;
    readonly patches: readonly BundlePatchRow[];
  }): Promise<boolean>;
}

export const createDynamoDBAggregateMutations = (
  store: DynamoDBStore,
): DynamoDBAggregateMutations => ({
  async insertBundleWithPatches({ bundle, patches }): Promise<void> {
    assertUniquePatches(patches);
    const counter = metadataUpdate(store, {
      bundles: 1,
      bundle_patches: patches.length,
    });
    if (!counter) return;
    await commitDynamoDBTransaction(store, [
      counter,
      ...baseReferenceChanges(store, bundle.id, [], patches),
      putNewBundle(store, bundle, patches.length),
      ...patches.map((patch) => putPatch(store, patch, undefined)),
    ]);
  },
  async updateBundleWithPatches({
    bundleId,
    update,
    patches,
  }): Promise<boolean> {
    assertUniquePatches(patches);
    const bundle = await loadBundleItem(store, bundleId);
    if (!bundle) return false;
    const currentPatches = (await loadPatchItems(store)).filter(
      ({ row }) => row.bundle_id === bundleId,
    );
    const currentById = new Map(
      currentPatches.map((patch) => [patch.sk, patch]),
    );
    const nextIds = new Set(patches.map(({ id }) => id));
    const relationCount =
      bundle.relation_count - currentPatches.length + patches.length;
    const counter = metadataUpdate(store, {
      bundle_patches: patches.length - currentPatches.length,
    });
    await commitDynamoDBTransaction(store, [
      ...(counter ? [counter] : []),
      ...baseReferenceChanges(
        store,
        bundleId,
        currentPatches.map(({ row }) => row),
        patches,
      ),
      putUpdatedBundle(
        store,
        bundle,
        { ...bundle.row, ...update },
        relationCount,
        patches.length,
      ),
      ...currentPatches
        .filter(({ sk }) => !nextIds.has(sk))
        .map((patch) => deletePatch(store, patch)),
      ...patches.map((patch) =>
        putPatch(store, patch, currentById.get(patch.id)),
      ),
    ]);
    return true;
  },
});

class DynamoDBCommitStateError extends Error {
  readonly name = "DynamoDBCommitStateError";

  constructor(message: string) {
    super(message);
  }
}

const rowsEqual = (left: object, right: object): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const putChannel = (
  store: DynamoDBStore,
  row: ChannelRow,
  current: DynamoDBChannelItem | undefined,
  referenceCount: number,
): DynamoDBTransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: boundedDynamoDBMetadataItem(
      toDynamoDBChannelItem(row, (current?.version ?? 0) + 1, referenceCount),
    ),
    ConditionExpression: current
      ? "#version = :version"
      : "attribute_not_exists(#pk)",
    ExpressionAttributeNames: current
      ? { "#version": "version" }
      : { "#pk": "pk" },
    ...(current
      ? { ExpressionAttributeValues: { ":version": current.version } }
      : {}),
  },
});

const deleteChannelActions = (
  store: DynamoDBStore,
  current: DynamoDBChannelItem,
): readonly DynamoDBTransactItem[] => [
  {
    Delete: {
      TableName: store.tableName,
      Key: itemKey(DYNAMODB_CHANNEL_PARTITION, current.sk),
      ConditionExpression: "#version = :version",
      ExpressionAttributeNames: {
        "#version": "version",
      },
      ExpressionAttributeValues: {
        ":version": current.version,
      },
    },
  },
  {
    Delete: {
      TableName: store.tableName,
      Key: {
        pk: DYNAMODB_CHANNEL_NAME_PARTITION,
        sk: current.row.name,
      },
      ConditionExpression: "#channelId = :channelId",
      ExpressionAttributeNames: { "#channelId": "channel_id" },
      ExpressionAttributeValues: { ":channelId": current.sk },
    },
  },
];

const updateChannelReferenceCount = (
  store: DynamoDBStore,
  current: DynamoDBChannelItem,
  delta: number,
): DynamoDBTransactItem => ({
  Update: {
    TableName: store.tableName,
    Key: itemKey(DYNAMODB_CHANNEL_PARTITION, current.sk),
    ConditionExpression:
      "#row.#name = :name" +
      (delta < 0 ? " AND #referenceCount >= :removal" : ""),
    UpdateExpression:
      "SET #version = #version + :one ADD #referenceCount :delta",
    ExpressionAttributeNames: {
      "#row": "row",
      "#name": "name",
      "#version": "version",
      "#referenceCount": "reference_count",
    },
    ExpressionAttributeValues: {
      ":name": current.row.name,
      ":one": 1,
      ":delta": delta,
      ...(delta < 0 ? { ":removal": -delta } : {}),
    },
  },
});

type VersionedApiKey = {
  readonly row: ApiKeyRow;
  readonly version: number;
};

const loadApiKeyByHash = async (
  store: DynamoDBStore,
  hash: string,
): Promise<VersionedApiKey | null> => {
  const { Item } = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: { pk: DYNAMODB_API_KEY_HASH_PARTITION, sk: hash },
      ConsistentRead: true,
    }),
  );
  if (Item === undefined) return null;
  const id = Item.api_key_id;
  if (typeof id !== "string") throw new DynamoDBStoredItemError();
  return loadApiKey(store, id);
};

const compileAndCommitDynamoDBChanges = async (
  store: DynamoDBStore,
  input: DatabaseCommit,
): Promise<DatabaseCommitResult> => {
  const [
    originalBundleItems,
    originalPatchItems,
    originalChannelItems,
    originalReleaseItems,
    originalReleaseCatalogItems,
  ] = await Promise.all([
    loadBundleItems(store),
    loadPatchItems(store),
    loadChannelItems(store),
    loadReleaseItems(store),
    loadReleaseCatalogItems(store),
  ]);
  const bundles = new Map(
    originalBundleItems.map(({ sk, row }) => [sk, row] as const),
  );
  const patches = new Map(
    originalPatchItems.map(({ sk, row }) => [sk, row] as const),
  );
  const channels = new Map(
    originalChannelItems.map(({ sk, row }) => [sk, row] as const),
  );
  const channelNames = new Map(
    originalChannelItems.map(({ sk, row }) => [row.name, sk] as const),
  );
  const releases = new Map(
    originalReleaseItems.map(({ sk, row }) => [sk, row] as const),
  );
  const releaseCatalogs = new Map(
    originalReleaseCatalogItems.map(({ sk, row }) => [sk, row] as const),
  );
  const originalApiKeys = new Map<string, VersionedApiKey>();
  const apiKeys = new Map<string, VersionedApiKey>();
  const apiKeyHashes = new Map<string, string>();

  const rememberApiKey = (value: VersionedApiKey | null): void => {
    if (value === null || apiKeys.has(value.row.id)) return;
    originalApiKeys.set(value.row.id, value);
    apiKeys.set(value.row.id, value);
    apiKeyHashes.set(value.row.hash, value.row.id);
  };

  const requireReleaseReferences = (row: ReleaseRow): void => {
    if (!channels.has(row.channel_id)) {
      throw new DynamoDBCommitStateError(
        `Release "${row.id}" references an invalid channel`,
      );
    }
    if (row.bundle_id !== null) {
      const bundle = bundles.get(row.bundle_id);
      if (bundle === undefined || bundle.platform !== row.platform) {
        throw new DynamoDBCommitStateError(
          `Release "${row.id}" references an invalid bundle`,
        );
      }
    }
  };

  for (const expectation of input.expectations ?? []) {
    const actualVersion =
      expectation.model === "releases"
        ? (releases.get(expectation.id)?.revision ?? null)
        : (releaseCatalogs.get(expectation.scopeKey)?.generation ?? null);
    const expectedVersion =
      expectation.model === "releases"
        ? expectation.revision
        : expectation.generation;
    if (actualVersion !== expectedVersion) {
      return {
        committed: false,
        conflict: {
          actualVersion,
          changeIndex: -1,
          expectedVersion,
          key:
            expectation.model === "releases"
              ? expectation.id
              : expectation.scopeKey,
          model: expectation.model,
          reason: "version_conflict",
        },
      };
    }
  }

  for (const [changeIndex, change] of input.changes.entries()) {
    switch (change.model) {
      case "channels":
        if (change.operation === "insert") {
          const canonicalId = channelNames.get(change.row.name);
          if (canonicalId !== undefined) break;
          const reusedId = channels.get(change.row.id);
          if (reusedId !== undefined) {
            throw new DynamoDBCommitStateError(
              `Channel id "${change.row.id}" already exists`,
            );
          }
          channels.set(change.row.id, change.row);
          channelNames.set(change.row.name, change.row.id);
        } else {
          const current = channels.get(change.where.id);
          if (current === undefined) break;
          if (
            [...releases.values()].some(
              ({ channel_id }) => channel_id === change.where.id,
            )
          ) {
            return {
              committed: false,
              conflict: { changeIndex, reason: "referenced" },
            };
          }
          channels.delete(change.where.id);
          channelNames.delete(current.name);
        }
        break;
      case "bundles":
        if (change.operation === "insert") {
          if (bundles.has(change.row.id)) {
            throw new DynamoDBCommitStateError(
              `Bundle "${change.row.id}" already exists`,
            );
          }
          bundles.set(change.row.id, change.row);
        } else {
          const current = bundles.get(change.where.id);
          if (current === undefined) {
            if (change.operation === "update") {
              return {
                committed: false,
                conflict: { changeIndex, reason: "not_found" },
              };
            }
            break;
          }
          if (change.operation === "update") {
            const row = { ...current, ...change.update };
            bundles.set(row.id, row);
          } else {
            if (
              [...releases.values()].some(
                ({ bundle_id }) => bundle_id === change.where.id,
              )
            ) {
              return {
                committed: false,
                conflict: { changeIndex, reason: "referenced" },
              };
            }
            bundles.delete(change.where.id);
            for (const [id, patch] of patches) {
              if (
                patch.bundle_id === change.where.id ||
                patch.base_bundle_id === change.where.id
              ) {
                patches.delete(id);
              }
            }
          }
        }
        break;
      case "releases":
        if (change.operation === "insert") {
          requireReleaseReferences(change.row);
          if (releases.has(change.row.id)) {
            throw new DynamoDBCommitStateError(
              `Release "${change.row.id}" already exists`,
            );
          }
          releases.set(change.row.id, change.row);
        } else {
          const current = releases.get(change.where.id);
          if (current === undefined) {
            if (change.operation === "update") {
              return {
                committed: false,
                conflict: { changeIndex, reason: "not_found" },
              };
            }
            break;
          }
          if (change.operation === "update") {
            const row = { ...current, ...change.update };
            requireReleaseReferences(row);
            releases.set(row.id, row);
          } else {
            releases.delete(change.where.id);
          }
        }
        break;
      case "releaseCatalogs":
        if (!channels.has(change.row.channel_id)) {
          throw new DynamoDBCommitStateError(
            `Release catalog "${change.row.scope_key}" references an invalid channel`,
          );
        }
        releaseCatalogs.set(change.row.scope_key, change.row);
        break;
      case "bundlePatches":
        if (change.operation === "insert") {
          if (
            !bundles.has(change.row.bundle_id) ||
            !bundles.has(change.row.base_bundle_id)
          ) {
            throw new DynamoDBCommitStateError(
              `Patch "${change.row.id}" references a missing bundle`,
            );
          }
          if (patches.has(change.row.id)) {
            throw new DynamoDBDuplicatePatchError(change.row.id);
          }
          patches.set(change.row.id, change.row);
        } else {
          for (const [id, patch] of patches) {
            if (patch.bundle_id === change.where.bundleId) {
              patches.delete(id);
            }
          }
        }
        break;
      case "apiKeys":
        if (change.operation === "insert") {
          rememberApiKey(await loadApiKeyByHash(store, change.row.hash));
          if (apiKeyHashes.has(change.row.hash)) break;
          rememberApiKey(await loadApiKey(store, change.row.id));
          if (apiKeys.has(change.row.id)) {
            throw new DynamoDBCommitStateError(
              `API key id "${change.row.id}" already exists`,
            );
          }
          const inserted = { row: change.row, version: 1 };
          apiKeys.set(change.row.id, inserted);
          apiKeyHashes.set(change.row.hash, change.row.id);
        } else {
          rememberApiKey(await loadApiKey(store, change.where.id));
          const current = apiKeys.get(change.where.id);
          if (current === undefined) {
            return {
              committed: false,
              conflict: { changeIndex, reason: "not_found" },
            };
          }
          apiKeys.set(change.where.id, {
            row: {
              ...current.row,
              revoked_at_ms: change.update.revokedAtMs,
            },
            version: current.version,
          });
        }
        break;
      default:
        throw new DynamoDBCommitStateError("Unsupported DynamoDB commit model");
    }
  }

  const relationCounts = new Map<string, number>();
  const ownedPatchCounts = new Map<string, number>();
  for (const patch of patches.values()) {
    for (const id of new Set([patch.bundle_id, patch.base_bundle_id])) {
      relationCounts.set(id, (relationCounts.get(id) ?? 0) + 1);
    }
    ownedPatchCounts.set(
      patch.bundle_id,
      (ownedPatchCounts.get(patch.bundle_id) ?? 0) + 1,
    );
  }
  const channelReferenceCounts = new Map<string, number>();
  for (const release of releases.values()) {
    channelReferenceCounts.set(
      release.channel_id,
      (channelReferenceCounts.get(release.channel_id) ?? 0) + 1,
    );
  }

  const actions: DynamoDBTransactItem[] = [];
  const originalChannels = new Map(
    originalChannelItems.map((item) => [item.sk, item] as const),
  );
  for (const original of originalChannelItems) {
    if (!channels.has(original.sk)) {
      actions.push(...deleteChannelActions(store, original));
    }
  }
  for (const [id, row] of channels) {
    const original = originalChannels.get(id);
    const referenceCount = channelReferenceCounts.get(id) ?? 0;
    if (original === undefined) {
      actions.push(putChannel(store, row, original, referenceCount));
      actions.push({
        Put: {
          TableName: store.tableName,
          Item: {
            pk: DYNAMODB_CHANNEL_NAME_PARTITION,
            sk: row.name,
            channel_id: id,
          },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      });
    } else {
      if (!rowsEqual(original.row, row)) {
        throw new DynamoDBCommitStateError(`Channel "${id}" cannot be updated`);
      }
      const delta = referenceCount - original.reference_count;
      if (delta !== 0) {
        actions.push(updateChannelReferenceCount(store, original, delta));
      }
    }
  }

  const originalBundles = new Map(
    originalBundleItems.map((item) => [item.sk, item] as const),
  );
  for (const original of originalBundleItems) {
    if (!bundles.has(original.sk)) actions.push(deleteAction(store, original));
  }
  for (const [id, row] of bundles) {
    const original = originalBundles.get(id);
    const relationCount = relationCounts.get(id) ?? 0;
    const ownedPatchCount = ownedPatchCounts.get(id) ?? 0;
    if (original === undefined) {
      actions.push(putNewBundle(store, row, relationCount, ownedPatchCount));
    } else if (!rowsEqual(original.row, row)) {
      actions.push(
        putUpdatedBundle(store, original, row, relationCount, ownedPatchCount),
      );
    } else {
      const relationDelta = relationCount - original.relation_count;
      const ownedPatchDelta = ownedPatchCount - original.owned_patch_count;
      if (relationDelta !== 0 || ownedPatchDelta !== 0) {
        actions.push(
          updateBundleRelation(store, id, relationDelta, ownedPatchDelta),
        );
      }
    }
  }

  const originalPatches = new Map(
    originalPatchItems.map((item) => [item.sk, item] as const),
  );
  for (const original of originalPatchItems) {
    if (!patches.has(original.sk)) actions.push(deletePatch(store, original));
  }
  for (const [id, row] of patches) {
    const original = originalPatches.get(id);
    if (original === undefined || !rowsEqual(original.row, row)) {
      actions.push(putPatch(store, row, original));
    }
  }

  const originalReleases = new Map(
    originalReleaseItems.map((item) => [item.sk, item] as const),
  );
  for (const original of originalReleaseItems) {
    const next = releases.get(original.sk);
    if (next !== undefined) continue;
    actions.push(deleteAction(store, original));
    actions.push({
      Delete: {
        TableName: store.tableName,
        Key: { pk: DYNAMODB_RELEASE_ID_PARTITION, sk: original.sk },
        ConditionExpression: "#scopeKey = :scopeKey",
        ExpressionAttributeNames: { "#scopeKey": "scope_key" },
        ExpressionAttributeValues: {
          ":scopeKey": original.row.scope_key,
        },
      },
    });
  }
  for (const [id, row] of releases) {
    const original = originalReleases.get(id);
    if (original === undefined) {
      actions.push({
        Put: {
          TableName: store.tableName,
          Item: boundedDynamoDBMetadataItem(toDynamoDBReleaseItem(row)),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      });
      actions.push({
        Put: {
          TableName: store.tableName,
          Item: releaseLocatorItem(row),
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      });
    } else if (!rowsEqual(original.row, row)) {
      const moved = original.row.scope_key !== row.scope_key;
      if (moved) actions.push(deleteAction(store, original));
      actions.push({
        Put: {
          TableName: store.tableName,
          Item: boundedDynamoDBMetadataItem(
            toDynamoDBReleaseItem(row, original.version + 1),
          ),
          ConditionExpression: moved
            ? "attribute_not_exists(#pk)"
            : "#version = :version",
          ExpressionAttributeNames: moved
            ? { "#pk": "pk" }
            : { "#version": "version" },
          ...(moved
            ? {}
            : {
                ExpressionAttributeValues: { ":version": original.version },
              }),
        },
      });
      if (moved) {
        actions.push({
          Put: {
            TableName: store.tableName,
            Item: releaseLocatorItem(row),
            ConditionExpression: "#scopeKey = :scopeKey",
            ExpressionAttributeNames: { "#scopeKey": "scope_key" },
            ExpressionAttributeValues: {
              ":scopeKey": original.row.scope_key,
            },
          },
        });
      }
    }
  }

  const originalReleaseCatalogs = new Map(
    originalReleaseCatalogItems.map((item) => [item.sk, item] as const),
  );
  for (const [scopeKey, row] of releaseCatalogs) {
    const original = originalReleaseCatalogs.get(scopeKey);
    if (original === undefined || !rowsEqual(original.row, row)) {
      actions.push({
        Put: {
          TableName: store.tableName,
          Item: boundedDynamoDBCatalogItem(
            toDynamoDBReleaseCatalogItem(row, (original?.version ?? 0) + 1),
          ),
          ConditionExpression: original
            ? "#version = :version"
            : "attribute_not_exists(#pk)",
          ExpressionAttributeNames: original
            ? { "#version": "version" }
            : { "#pk": "pk" },
          ...(original
            ? {
                ExpressionAttributeValues: { ":version": original.version },
              }
            : {}),
        },
      });
    }
  }

  const changedReleaseIds = new Set(
    [...new Set([...originalReleases.keys(), ...releases.keys()])].filter(
      (id) => {
        const original = originalReleases.get(id)?.row;
        const next = releases.get(id);
        return (
          original === undefined ||
          next === undefined ||
          !rowsEqual(original, next)
        );
      },
    ),
  );
  const changedCatalogScopes = new Set(
    [...releaseCatalogs].flatMap(([scopeKey, row]) => {
      const original = originalReleaseCatalogs.get(scopeKey)?.row;
      return original === undefined || !rowsEqual(original, row)
        ? [scopeKey]
        : [];
    }),
  );
  for (const expectation of input.expectations ?? []) {
    if (
      expectation.model === "releases" &&
      !changedReleaseIds.has(expectation.id)
    ) {
      const original = originalReleases.get(expectation.id);
      actions.push({
        ConditionCheck: {
          TableName: store.tableName,
          Key:
            original === undefined
              ? { pk: DYNAMODB_RELEASE_ID_PARTITION, sk: expectation.id }
              : { pk: original.pk, sk: original.sk },
          ConditionExpression:
            original === undefined
              ? "attribute_not_exists(#pk)"
              : "#version = :version",
          ExpressionAttributeNames:
            original === undefined
              ? { "#pk": "pk" }
              : { "#version": "version" },
          ...(original === undefined
            ? {}
            : {
                ExpressionAttributeValues: { ":version": original.version },
              }),
        },
      });
    }
    if (
      expectation.model === "releaseCatalogs" &&
      !changedCatalogScopes.has(expectation.scopeKey)
    ) {
      const original = originalReleaseCatalogs.get(expectation.scopeKey);
      actions.push({
        ConditionCheck: {
          TableName: store.tableName,
          Key: itemKey("release_catalogs", expectation.scopeKey),
          ConditionExpression:
            original === undefined
              ? "attribute_not_exists(#pk)"
              : "#version = :version",
          ExpressionAttributeNames:
            original === undefined
              ? { "#pk": "pk" }
              : { "#version": "version" },
          ...(original === undefined
            ? {}
            : {
                ExpressionAttributeValues: { ":version": original.version },
              }),
        },
      });
    }
  }

  const counter = metadataUpdate(store, {
    bundles: bundles.size - originalBundles.size,
    bundle_patches: patches.size - originalPatches.size,
  });
  if (counter !== undefined) actions.push(counter);

  for (const [id, current] of apiKeys) {
    const original = originalApiKeys.get(id);
    if (original !== undefined && rowsEqual(original.row, current.row)) {
      continue;
    }
    actions.push({
      Put: {
        TableName: store.tableName,
        Item: boundedDynamoDBMetadataItem(
          apiKeyItem(
            current.row,
            original === undefined ? 1 : original.version + 1,
          ),
        ),
        ConditionExpression: original
          ? "#version = :version"
          : "attribute_not_exists(#pk)",
        ExpressionAttributeNames: original
          ? { "#version": "version" }
          : { "#pk": "pk" },
        ...(original
          ? {
              ExpressionAttributeValues: { ":version": original.version },
            }
          : {}),
      },
    });
    if (original === undefined) {
      actions.push({
        Put: {
          TableName: store.tableName,
          Item: {
            pk: DYNAMODB_API_KEY_HASH_PARTITION,
            sk: current.row.hash,
            api_key_id: current.row.id,
          },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        },
      });
    }
  }

  if (actions.length > 0) await commitDynamoDBTransaction(store, actions);
  return { committed: true };
};

const isDynamoDBTransactionConflict = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "name") === "TransactionCanceledException";

const createDynamoDBCommit =
  (store: DynamoDBStore) =>
  async (input: DatabaseCommit): Promise<DatabaseCommitResult> => {
    try {
      return await compileAndCommitDynamoDBChanges(store, input);
    } catch (error) {
      if (!isDynamoDBTransactionConflict(error)) throw error;
      return compileAndCommitDynamoDBChanges(store, input);
    }
  };
export const DYNAMODB_API_KEY_PARTITION = "api_keys";
export const DYNAMODB_API_KEY_HASH_PARTITION = "_hot-updater#api-key-hashes";

const isApiKeyRow = (value: unknown): value is ApiKeyRow =>
  typeof value === "object" &&
  value !== null &&
  typeof field(value, "id") === "string" &&
  typeof field(value, "hash") === "string" &&
  typeof field(value, "name") === "string" &&
  typeof field(value, "prefix") === "string" &&
  field(value, "role") === "client" &&
  typeof field(value, "created_at_ms") === "number" &&
  (field(value, "revoked_at_ms") === null ||
    typeof field(value, "revoked_at_ms") === "number");

const parseOfficialRowItem = <TRow>(
  value: Record<string, unknown>,
  partition: string,
  isRow: (row: unknown) => row is TRow,
): { readonly row: TRow; readonly version: number } => {
  if (
    value.pk !== partition ||
    typeof value.sk !== "string" ||
    typeof value.version !== "number" ||
    !isRow(value.row)
  ) {
    throw new DynamoDBStoredItemError();
  }
  return { row: value.row, version: value.version };
};

const apiKeyItem = (
  row: ApiKeyRow,
  version: number,
): Record<string, unknown> => ({
  pk: DYNAMODB_API_KEY_PARTITION,
  sk: row.id,
  version,
  row,
});

const loadApiKey = async (
  store: DynamoDBStore,
  id: string,
): Promise<{
  readonly row: ApiKeyRow;
  readonly version: number;
} | null> => {
  const result = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: { pk: DYNAMODB_API_KEY_PARTITION, sk: id },
      ConsistentRead: true,
    }),
  );
  return result.Item === undefined
    ? null
    : parseOfficialRowItem(
        result.Item,
        DYNAMODB_API_KEY_PARTITION,
        isApiKeyRow,
      );
};

export const createDynamoDBApiKeyTable = (
  store: DynamoDBStore,
): ApiKeyModel => {
  const findByHash = async (hash: string): Promise<ApiKeyRow | null> => {
    const lookup = await store.client.send(
      new GetCommand({
        TableName: store.tableName,
        Key: { pk: DYNAMODB_API_KEY_HASH_PARTITION, sk: hash },
        ConsistentRead: true,
      }),
    );
    const id = lookup.Item?.api_key_id;
    if (lookup.Item === undefined) return null;
    if (typeof id !== "string") throw new DynamoDBStoredItemError();
    return (await loadApiKey(store, id))?.row ?? null;
  };

  return {
    async create(row) {
      if ((await findByHash(row.hash)) !== null) return "existing";
      try {
        await commitDynamoDBTransaction(store, [
          {
            Put: {
              TableName: store.tableName,
              Item: boundedDynamoDBMetadataItem(apiKeyItem(row, 1)),
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" },
            },
          },
          {
            Put: {
              TableName: store.tableName,
              Item: {
                pk: DYNAMODB_API_KEY_HASH_PARTITION,
                sk: row.hash,
                api_key_id: row.id,
              },
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" },
            },
          },
        ]);
        return "created";
      } catch (error) {
        if ((await findByHash(row.hash)) !== null) return "existing";
        throw error;
      }
    },
    findByHash,
    async list() {
      const rows: ApiKeyRow[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await store.client.send(
          new QueryCommand({
            TableName: store.tableName,
            ExclusiveStartKey: exclusiveStartKey,
            KeyConditionExpression: "#pk = :pk",
            ExpressionAttributeNames: { "#pk": "pk" },
            ExpressionAttributeValues: {
              ":pk": DYNAMODB_API_KEY_PARTITION,
            },
            ConsistentRead: true,
          }),
        );
        rows.push(
          ...(page.Items ?? []).map(
            (item) =>
              parseOfficialRowItem(
                item,
                DYNAMODB_API_KEY_PARTITION,
                isApiKeyRow,
              ).row,
          ),
        );
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
      return rows.sort(
        (left, right) =>
          right.created_at_ms - left.created_at_ms ||
          left.id.localeCompare(right.id),
      );
    },
    async revoke({ id, revokedAtMs }) {
      const current = await loadApiKey(store, id);
      if (current === null) return null;
      const row = { ...current.row, revoked_at_ms: revokedAtMs };
      await store.client.send(
        new PutCommand({
          TableName: store.tableName,
          Item: boundedDynamoDBMetadataItem(
            apiKeyItem(row, current.version + 1),
          ),
          ConditionExpression: "#version = :currentVersion",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: { ":currentVersion": current.version },
        }),
      );
      return row;
    },
  };
};

export const DYNAMODB_UPDATE_INDEX_NAME = "hot-updater-update-index";

export interface DynamoDBConfig extends DynamoDBClientConfig {
  readonly apiBasePath?: string;
  readonly cloudfrontDistributionId?: string;
  readonly insightsDatabaseNamespace: string;
  readonly shouldWaitForInvalidation?: boolean;
  readonly tableName: string;
}

export const dynamoDB = (config: DynamoDBConfig) => {
  const {
    apiBasePath = "/release-catalogs",
    cloudfrontDistributionId,
    insightsDatabaseNamespace,
    shouldWaitForInvalidation = false,
    tableName,
    ...clientConfig
  } = config;
  const client = DynamoDBDocumentClient.from(new DynamoDBClient(clientConfig), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const cloudFront = cloudfrontDistributionId
    ? new CloudFrontClient({
        credentials: clientConfig.credentials,
        region: clientConfig.region,
      })
    : null;
  const store = { client, tableName };
  const insights = createDynamoDBInsightsModel({
    ...store,
    insightsDatabaseNamespace,
  });
  const crud = createDynamoDBCrud(store, DYNAMODB_UPDATE_INDEX_NAME, insights);
  const invalidateUpdateRoutes = async () => {
    if (!cloudFront || !cloudfrontDistributionId) return;
    try {
      await invalidateCloudFront(
        cloudFront,
        cloudfrontDistributionId,
        [`${apiBasePath.replace(/\/+$/, "")}/*`],
        { shouldWait: shouldWaitForInvalidation },
      );
    } catch (error) {
      console.warn(
        "[hot-updater/aws] CloudFront invalidation failed; continuing without cache invalidation.",
        {
          distributionId: cloudfrontDistributionId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      );
    }
  };
  const adapter = createDatabasePluginAdapter("dynamoDB", {
    ...crud,
    commit: createDynamoDBCommit(store),
    dispose: async () => {
      client.destroy();
      cloudFront?.destroy();
    },
  });
  return createDatabasePlugin({
    name: "dynamoDB",
    models: {
      ...adapter.models,
      bundlePatches: createDynamoDBBundlePatchTable(
        store,
        DYNAMODB_UPDATE_INDEX_NAME,
      ),
      apiKeys: createDynamoDBApiKeyTable(store),
    },
    async commit(input) {
      const result = await adapter.commit(input);
      if (
        result.committed &&
        input.changes.some(
          ({ model }) => model === "bundles" || model === "bundlePatches",
        )
      ) {
        await invalidateUpdateRoutes();
      }
      return result;
    },
    dispose: adapter.dispose,
  });
};
