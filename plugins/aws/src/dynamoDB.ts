import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  type NativeAttributeValue,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { NIL_UUID } from "@hot-updater/core";
import {
  attachDatabasePluginAggregateMutations,
  attachDatabasePluginPatchHydration,
  attachUniversalComponentDataAdapter,
  type BundlePatchRow,
  type BundleRow,
  createDatabasePlugin,
  type DatabaseDistinctOn,
  type DatabaseImplementationResult,
  type DatabaseModel,
  type DatabaseOrderBy,
  type DatabasePluginAggregateMutations,
  type DatabasePluginImplementation,
  type DatabaseRow,
  type DatabaseWhere,
  filterCompatibleAppVersions,
  getUniversalComponentLatestSchema,
  getUniversalComponentSchemaMarkerKey,
  getUniversalComponentTable,
  isDatabaseMetadataObject,
  resolveUniversalComponentMigrationState,
  resolveUpdateInfoFromBundles,
  rowToBundle,
  UniversalComponentDataStateNotReadyError,
  type UniversalComponentDataAdapter,
  type UniversalComponentAppendInput,
  type UniversalComponentOrderedScanSchema,
  type UniversalComponentRow,
  type UniversalComponentScalar,
  type UniversalComponentSchema,
  UniversalComponentSchemaNotReadyError,
  type UniversalComponentSchemaVersion,
  type UniversalComponentTableSchema,
  validateUniversalComponentAppend,
  validateUniversalComponentGet,
  validateUniversalComponentOrderedScan,
  validateUniversalComponentRow,
} from "@hot-updater/plugin-core";

import { invalidateCloudFront } from "./cloudFrontInvalidation";

export const DYNAMODB_MAX_METADATA_ITEM_BYTES = 8 * 1_024;

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
  if (where?.length !== 1) return undefined;
  const condition = where[0];
  if (
    Reflect.get(condition, "field") !== "id" ||
    Reflect.get(condition, "mode") === "insensitive"
  ) {
    return undefined;
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
  parseDynamoDBItem(boundedDynamoDBMetadataItem(item));

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
  model: DatabaseModel,
): Promise<DynamoDBItem[]> =>
  queryItems(store, { partition: model, consistentRead: true });

const loadModelItem = async (
  store: DynamoDBStore,
  model: DatabaseModel,
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

export const queryUpdateBundles = async (
  store: DynamoDBStore,
  indexName: string,
  input: {
    readonly channel: string;
    readonly minimumBundleId: string;
    readonly platform: BundleRow["platform"];
  },
): Promise<BundleRow[]> => {
  const partition = bundleUpdatePartition({
    channel: input.channel,
    enabled: true,
    platform: input.platform,
  });
  const items = await queryItems(store, {
    partition,
    indexName,
    minimumSortKey: input.minimumBundleId,
  });
  return items
    .filter((item): item is DynamoDBBundleItem => item.pk === "bundles")
    .map(({ row }) => row);
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

const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (left == null) return right == null ? 0 : -1;
  if (right == null) return 1;
  return String(left).localeCompare(String(right));
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
    Key: itemKey(item.pk, item.sk),
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

export const createDynamoDBCrud = (
  store: DynamoDBStore,
  updateIndexName: string,
): DatabasePluginImplementation => ({
  async create(input): Promise<DatabaseImplementationResult> {
    switch (input.model) {
      case "bundles":
        await createDynamoDBBundle(store, input.data);
        return input.data;
      case "bundle_patches":
        await createDynamoDBPatch(store, input.data);
        return input.data;
    }
    throw new DynamoDBUnsupportedModelError();
  },
  async update(input): Promise<DatabaseImplementationResult | null> {
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
    if (input.model === "bundle_patches") {
      const items = (await loadPatchItems(store)).filter(({ row }) =>
        matchesDynamoDBWhere(row, input.where),
      );
      for (const item of items) await deleteDynamoDBPatch(store, item);
      return;
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
    }
    throw new DynamoDBUnsupportedModelError();
  },
  async getChannels(): Promise<string[]> {
    return [
      ...new Set((await loadBundleItems(store)).map(({ row }) => row.channel)),
    ].sort();
  },
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
): DynamoDBTransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: boundedDynamoDBMetadataItem(
      toDynamoDBBundleItem(row, 1, relationCount, relationCount),
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

export const createDynamoDBAggregateMutations = (
  store: DynamoDBStore,
): DatabasePluginAggregateMutations => ({
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

type GetUpdateInfo = NonNullable<DatabasePluginImplementation["getUpdateInfo"]>;

const compatibleRows = (
  rows: readonly BundleRow[],
  appVersion: string,
): BundleRow[] => {
  const versions = filterCompatibleAppVersions(
    rows.flatMap(({ target_app_version: version }) =>
      version === null ? [] : [version],
    ),
    appVersion,
  );
  const compatible = new Set(versions);
  return rows.filter(
    ({ target_app_version: version }) =>
      version !== null && compatible.has(version),
  );
};

export const createDynamoDBGetUpdateInfo =
  (store: DynamoDBStore, indexName: string): GetUpdateInfo =>
  async (args) => {
    const channel = args.channel ?? "production";
    const minBundleId = args.minBundleId ?? NIL_UUID;
    const candidates = await queryUpdateBundles(store, indexName, {
      channel,
      minimumBundleId: minBundleId,
      platform: args.platform,
    });
    const rows =
      args._updateStrategy === "appVersion"
        ? compatibleRows(candidates, args.appVersion)
        : candidates.filter(
            ({ fingerprint_hash: fingerprintHash }) =>
              fingerprintHash === args.fingerprintHash,
          );
    return resolveUpdateInfoFromBundles({
      args: { ...args, channel, minBundleId },
      bundles: rows.map((row) => rowToBundle(row)),
    });
  };

export const DYNAMODB_COMPONENT_DATA_PARTITION_PREFIX =
  "_hot-updater#component-data";

export const DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY = "_hot-updater";

const catalogSortKey = "catalog";

type StoredItem = Record<string, unknown>;

class DynamoDBUniversalComponentSchemaDriftError extends Error {
  readonly name = "DynamoDBUniversalComponentSchemaDriftError";
}

class DynamoDBUniversalComponentStoredDataError extends Error {
  readonly name = "DynamoDBUniversalComponentStoredDataError";
}

class DynamoDBUniversalComponentIndexError extends Error {
  readonly name = "DynamoDBUniversalComponentIndexError";
}

const componentPartition = (schema: UniversalComponentSchema): string =>
  `${DYNAMODB_COMPONENT_DATA_PARTITION_PREFIX}#${schema.id}`;

const tablePartition = (
  schema: UniversalComponentSchema,
  table: string,
): string => `${componentPartition(schema)}#table#${table}`;

const scanPartition = (
  schema: UniversalComponentSchema,
  accessPattern: string,
): string => `${componentPartition(schema)}#scan#${accessPattern}`;

const catalogKey = (schema: UniversalComponentSchema) => ({
  pk: componentPartition(schema),
  sk: catalogSortKey,
});

const markerKey = (schema: UniversalComponentSchema) => ({
  pk: DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY,
  sk: getUniversalComponentSchemaMarkerKey(schema),
});

const versionShape = (version: UniversalComponentSchemaVersion): string =>
  JSON.stringify(version);

const itemString = (item: StoredItem, key: string): string => {
  const value = item[key];
  if (typeof value !== "string") {
    throw new DynamoDBUniversalComponentStoredDataError(
      `Invalid component item ${key}`,
    );
  }
  return value;
};

const itemRow = (item: StoredItem): UniversalComponentRow => {
  const value = item.data;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DynamoDBUniversalComponentStoredDataError(
      "Invalid component item data",
    );
  }
  return value as UniversalComponentRow;
};

const stableRowValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableRowValue).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableRowValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const stringBytes = (value: string): string =>
  Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const sortableNumber = (input: number): string => {
  const value = Object.is(input, -0) ? 0 : input;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  const bytes = new Uint8Array(buffer);
  if ((bytes[0]! & 0x80) === 0) {
    bytes[0]! ^= 0x80;
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index]! ^= 0xff;
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

const scalarSortKey = (value: UniversalComponentScalar): string =>
  `${typeof value === "number" ? sortableNumber(value) : stringBytes(value)}!`;

const tupleSortKey = (values: readonly UniversalComponentScalar[]): string =>
  values.map(scalarSortKey).join("");

const primaryKeyColumn = (table: UniversalComponentTableSchema): string =>
  table.columns.find(({ primaryKey }) => primaryKey)?.name ??
  (() => {
    throw new DynamoDBUniversalComponentSchemaDriftError(
      `Component table ${table.name} has no primary key`,
    );
  })();

const primaryKeyValue = (
  table: UniversalComponentTableSchema,
  row: UniversalComponentRow,
): string => {
  const value = row[primaryKeyColumn(table)];
  if (typeof value !== "string") {
    throw new DynamoDBUniversalComponentStoredDataError(
      `Invalid primary key for component table ${table.name}`,
    );
  }
  return value;
};

const primarySortKey = (
  table: UniversalComponentTableSchema,
  row: UniversalComponentRow,
): string => scalarSortKey(primaryKeyValue(table, row));

const scanValues = (
  scan: UniversalComponentOrderedScanSchema,
  row: UniversalComponentRow,
): readonly UniversalComponentScalar[] =>
  scan.columns.map((column) => {
    const value = row[column];
    if (typeof value !== "number" && typeof value !== "string") {
      throw new DynamoDBUniversalComponentStoredDataError(
        `Invalid ordered value for component access pattern ${scan.name}`,
      );
    }
    return value;
  });

const scanSortKey = (
  scan: UniversalComponentOrderedScanSchema,
  table: UniversalComponentTableSchema,
  row: UniversalComponentRow,
): string =>
  `${tupleSortKey(scanValues(scan, row))}~${scalarSortKey(
    primaryKeyValue(table, row),
  )}`;

const queryPartition = async (
  store: DynamoDBStore,
  partition: string,
): Promise<StoredItem[]> => {
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const items: StoredItem[] = [];
  do {
    const page = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        ExclusiveStartKey: exclusiveStartKey,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": partition },
      }),
    );
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
};

const getSetting = async (
  store: DynamoDBStore,
  key: { readonly pk: string; readonly sk: string },
): Promise<string | null> => {
  const { Item } = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: key,
      ProjectionExpression: "#value",
      ExpressionAttributeNames: { "#value": "value" },
    }),
  );
  if (Item === undefined) return null;
  if (typeof Item.value !== "string") {
    throw new DynamoDBUniversalComponentSchemaDriftError(
      `Invalid component setting ${key.sk}`,
    );
  }
  return Item.value;
};

const getCatalog = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
): Promise<{ readonly shape: string; readonly version: string } | null> => {
  const { Item } = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: catalogKey(schema),
    }),
  );
  if (Item === undefined) return null;
  if (typeof Item.value !== "string" || typeof Item.shape !== "string") {
    throw new DynamoDBUniversalComponentSchemaDriftError(
      `Invalid component catalog ${schema.id}`,
    );
  }
  return { shape: Item.shape, version: Item.value };
};

const assertCatalogVersion = (
  schema: UniversalComponentSchema,
  catalog: { readonly shape: string; readonly version: string } | null,
  version: UniversalComponentSchemaVersion,
): void => {
  if (
    catalog?.version !== version.version ||
    catalog.shape !== versionShape(version)
  ) {
    throw new DynamoDBUniversalComponentSchemaDriftError(
      `Component ${schema.id} physical catalog does not match version ${version.version}`,
    );
  }
};

const parsePrimaryItem = (
  schema: UniversalComponentSchema,
  version: UniversalComponentSchemaVersion,
  table: UniversalComponentTableSchema,
  item: StoredItem,
): UniversalComponentRow => {
  const row = itemRow(item);
  if (
    itemString(item, "pk") !== tablePartition(schema, table.name) ||
    itemString(item, "sk") !== primarySortKey(table, row)
  ) {
    throw new DynamoDBUniversalComponentStoredDataError(
      `Invalid stored item for component table ${table.name}`,
    );
  }
  try {
    validateUniversalComponentRow(schema, {
      row,
      table: table.name,
      version: version.version,
    });
  } catch (error) {
    throw new DynamoDBUniversalComponentStoredDataError(
      `Invalid stored row for component table ${table.name}`,
      { cause: error },
    );
  }
  return row;
};

const loadRows = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
  version: UniversalComponentSchemaVersion,
): Promise<ReadonlyMap<string, readonly UniversalComponentRow[]>> => {
  const rows = new Map<string, readonly UniversalComponentRow[]>();
  for (const table of version.tables) {
    const items = await queryPartition(
      store,
      tablePartition(schema, table.name),
    );
    rows.set(
      table.name,
      items.map((item) => parsePrimaryItem(schema, version, table, item)),
    );
  }
  return rows;
};

const assertIndexes = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
  version: UniversalComponentSchemaVersion,
  rows: ReadonlyMap<string, readonly UniversalComponentRow[]>,
): Promise<void> => {
  for (const scan of version.orderedScans ?? []) {
    const table = getUniversalComponentTable(
      schema,
      scan.table,
      version.version,
    );
    const expected = new Map(
      (rows.get(table.name) ?? []).map((row) => [
        scanSortKey(scan, table, row),
        {
          primary: primaryKeyValue(table, row),
          row: stableRowValue(row),
        },
      ]),
    );
    const items = await queryPartition(store, scanPartition(schema, scan.name));
    if (items.length !== expected.size) {
      throw new DynamoDBUniversalComponentIndexError(
        `Component access pattern ${scan.name} is incomplete`,
      );
    }
    for (const item of items) {
      const row = itemRow(item);
      const sk = itemString(item, "sk");
      if (
        itemString(item, "pk") !== scanPartition(schema, scan.name) ||
        sk !== scanSortKey(scan, table, row) ||
        itemString(item, "primary") !== primaryKeyValue(table, row) ||
        expected.get(sk)?.primary !== primaryKeyValue(table, row) ||
        expected.get(sk)?.row !== stableRowValue(row)
      ) {
        throw new DynamoDBUniversalComponentIndexError(
          `Invalid component access pattern ${scan.name}`,
        );
      }
    }
  }
};

const validatePhysicalState = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
  version: UniversalComponentSchemaVersion,
): Promise<ReadonlyMap<string, readonly UniversalComponentRow[]>> => {
  assertCatalogVersion(schema, await getCatalog(store, schema), version);
  const rows = await loadRows(store, schema, version);
  await assertIndexes(store, schema, version, rows);
  return rows;
};

const putCatalog = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
  version: UniversalComponentSchemaVersion,
): Promise<void> => {
  await store.client.send(
    new PutCommand({
      TableName: store.tableName,
      Item: {
        ...catalogKey(schema),
        shape: versionShape(version),
        value: version.version,
      },
    }),
  );
};

const putMarker = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
  version: string,
): Promise<void> => {
  await store.client.send(
    new PutCommand({
      TableName: store.tableName,
      Item: { ...markerKey(schema), value: version },
    }),
  );
};

const replaceIndexes = async (
  store: DynamoDBStore,
  schema: UniversalComponentSchema,
  previous: UniversalComponentSchemaVersion,
  next: UniversalComponentSchemaVersion,
  rows: ReadonlyMap<string, readonly UniversalComponentRow[]>,
): Promise<void> => {
  for (const scan of previous.orderedScans ?? []) {
    const partition = scanPartition(schema, scan.name);
    for (const item of await queryPartition(store, partition)) {
      await store.client.send(
        new DeleteCommand({
          TableName: store.tableName,
          Key: { pk: partition, sk: itemString(item, "sk") },
        }),
      );
    }
  }
  for (const scan of next.orderedScans ?? []) {
    const table = getUniversalComponentTable(schema, scan.table, next.version);
    for (const row of rows.get(table.name) ?? []) {
      await store.client.send(
        new PutCommand({
          TableName: store.tableName,
          Item: {
            data: row,
            pk: scanPartition(schema, scan.name),
            primary: primaryKeyValue(table, row),
            sk: scanSortKey(scan, table, row),
          },
        }),
      );
    }
  }
};

export const createDynamoDBUniversalComponentDataAdapter = (
  store: DynamoDBStore,
  onDatabaseUpdated?: () => Promise<void>,
): UniversalComponentDataAdapter => {
  const readinessValidated = new WeakSet<UniversalComponentSchema>();
  return {
    bind(schema) {
      const latest = getUniversalComponentLatestSchema(schema);
      const assertReady = async (): Promise<void> => {
        let actualVersion: string | null;
        try {
          actualVersion = await getSetting(store, markerKey(schema));
        } catch (error) {
          if (error instanceof DynamoDBUniversalComponentSchemaDriftError) {
            throw new UniversalComponentDataStateNotReadyError(
              schema.id,
              latest.version,
              "physical-schema",
              { cause: error },
            );
          }
          throw error;
        }
        if (actualVersion !== latest.version) {
          throw new UniversalComponentSchemaNotReadyError(
            schema.id,
            latest.version,
            actualVersion,
          );
        }
        if (!readinessValidated.has(schema)) {
          try {
            await validatePhysicalState(store, schema, latest);
          } catch (error) {
            if (error instanceof DynamoDBUniversalComponentIndexError) {
              throw new UniversalComponentDataStateNotReadyError(
                schema.id,
                latest.version,
                "index",
                { cause: error },
              );
            }
            if (error instanceof DynamoDBUniversalComponentStoredDataError) {
              throw new UniversalComponentDataStateNotReadyError(
                schema.id,
                latest.version,
                "stored-data",
                { cause: error },
              );
            }
            if (error instanceof DynamoDBUniversalComponentSchemaDriftError) {
              throw new UniversalComponentDataStateNotReadyError(
                schema.id,
                latest.version,
                "physical-schema",
                { cause: error },
              );
            }
            throw error;
          }
          readinessValidated.add(schema);
        }
      };
      const write = async (
        input: UniversalComponentAppendInput,
      ): Promise<void> => {
        const table = validateUniversalComponentAppend(schema, input);
        const primary = primaryKeyValue(table, input.row);
        const transactItems = [
          {
            Put: {
              TableName: store.tableName,
              Item: {
                data: input.row,
                pk: tablePartition(schema, table.name),
                sk: primarySortKey(table, input.row),
              },
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" },
            },
          },
          ...(latest.orderedScans ?? [])
            .filter(({ table: tableName }) => tableName === table.name)
            .map((scan) => ({
              Put: {
                TableName: store.tableName,
                Item: {
                  data: input.row,
                  pk: scanPartition(schema, scan.name),
                  primary,
                  sk: scanSortKey(scan, table, input.row),
                },
              },
            })),
        ];
        if (transactItems.length > 100) {
          throw new TypeError(
            `Component table ${table.name} exceeds the DynamoDB transaction limit`,
          );
        }
        await store.client.send(
          new TransactWriteCommand({ TransactItems: transactItems }),
        );
        await onDatabaseUpdated?.();
      };
      return {
        schema,
        assertReady,
        async append(input) {
          await assertReady();
          await write(input);
        },
        async create(input) {
          await assertReady();
          try {
            await write(input);
            return "created";
          } catch (error) {
            if (
              typeof error !== "object" ||
              error === null ||
              Reflect.get(error, "name") !== "TransactionCanceledException"
            ) {
              throw error;
            }
            const table = validateUniversalComponentAppend(schema, input);
            const { Item } = await store.client.send(
              new GetCommand({
                TableName: store.tableName,
                Key: {
                  pk: tablePartition(schema, table.name),
                  sk: scalarSortKey(primaryKeyValue(table, input.row)),
                },
                ConsistentRead: true,
              }),
            );
            if (Item !== undefined) return "existing";
            throw error;
          }
        },
        async get(input) {
          await assertReady();
          const table = validateUniversalComponentGet(schema, input);
          const { Item } = await store.client.send(
            new GetCommand({
              TableName: store.tableName,
              Key: {
                pk: tablePartition(schema, table.name),
                sk: scalarSortKey(input.primaryKey),
              },
              ConsistentRead: true,
            }),
          );
          if (Item === undefined) return null;
          try {
            return parsePrimaryItem(schema, latest, table, Item);
          } catch (error) {
            throw new UniversalComponentDataStateNotReadyError(
              schema.id,
              latest.version,
              "stored-data",
              { cause: error },
            );
          }
        },
        async orderedScan(input) {
          await assertReady();
          const scan = validateUniversalComponentOrderedScan(schema, input);
          const table = getUniversalComponentTable(schema, scan.table);
          const before = tupleSortKey(input.beforePrefixExclusive);
          const after =
            input.afterExclusive === undefined
              ? undefined
              : `${tupleSortKey(input.afterExclusive)}~\uffff`;
          if (after !== undefined && after >= before) return [];
          const parseItem = (item: StoredItem): UniversalComponentRow => {
            try {
              const row = itemRow(item);
              if (
                itemString(item, "pk") !== scanPartition(schema, scan.name) ||
                itemString(item, "sk") !== scanSortKey(scan, table, row)
              ) {
                throw new DynamoDBUniversalComponentStoredDataError(
                  `Invalid stored item for component access pattern ${scan.name}`,
                );
              }
              validateUniversalComponentRow(schema, {
                row,
                table: table.name,
                version: latest.version,
              });
              return row;
            } catch (error) {
              throw new UniversalComponentDataStateNotReadyError(
                schema.id,
                latest.version,
                "stored-data",
                { cause: error },
              );
            }
          };
          let exclusiveStartKey: Record<string, unknown> | undefined;
          const rows: UniversalComponentRow[] = [];
          do {
            const page = await store.client.send(
              new QueryCommand({
                TableName: store.tableName,
                ExclusiveStartKey: exclusiveStartKey,
                KeyConditionExpression:
                  after === undefined
                    ? "#pk = :pk AND #sk < :before"
                    : "#pk = :pk AND #sk BETWEEN :after AND :before",
                ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
                ExpressionAttributeValues: {
                  ":before": before,
                  ":pk": scanPartition(schema, scan.name),
                  ...(after === undefined ? {} : { ":after": after }),
                },
                Limit: input.limit - rows.length,
                ScanIndexForward: true,
              }),
            );
            rows.push(...(page.Items ?? []).map(parseItem));
            exclusiveStartKey = page.LastEvaluatedKey;
          } while (
            rows.length < input.limit &&
            exclusiveStartKey !== undefined
          );
          return rows;
        },
      };
    },
    async migrate(schema) {
      readinessValidated.delete(schema);
      const latest = getUniversalComponentLatestSchema(schema);
      const marker = await getSetting(store, markerKey(schema));
      const catalog = await getCatalog(store, schema);
      const physicalVersion = catalog?.version ?? null;
      if (catalog !== null) {
        const declared = schema.versions.find(
          ({ version }) => version === physicalVersion,
        );
        if (
          declared === undefined ||
          catalog.shape !== versionShape(declared)
        ) {
          throw new DynamoDBUniversalComponentSchemaDriftError(
            `Component ${schema.id} has an unknown physical catalog`,
          );
        }
      }
      const discriminatorValue =
        schema.unmarked === undefined
          ? null
          : await getSetting(store, {
              pk: DYNAMODB_COMPONENT_SCHEMA_PARTITION_KEY,
              sk: schema.unmarked.discriminatorKey,
            });
      const decision = resolveUniversalComponentMigrationState(schema, {
        discriminatorValue,
        markerVersion: marker,
        physicalVersion,
      });
      if (decision.kind === "reject") {
        throw new DynamoDBUniversalComponentSchemaDriftError(
          `Component ${schema.id} migration state is not adoptable`,
        );
      }
      if (decision.kind === "ready") {
        await validatePhysicalState(store, schema, latest);
        readinessValidated.add(schema);
        return { changed: false, version: latest.version };
      }
      if (
        decision.kind === "adopt" &&
        decision.fromVersion === latest.version
      ) {
        await validatePhysicalState(store, schema, latest);
        await putMarker(store, schema, latest.version);
        readinessValidated.add(schema);
        return { changed: true, version: latest.version };
      }
      if (decision.kind === "create") {
        const partitions = [
          ...latest.tables.map((table) => tablePartition(schema, table.name)),
          ...(latest.orderedScans ?? []).map((scan) =>
            scanPartition(schema, scan.name),
          ),
        ];
        for (const partition of partitions) {
          if ((await queryPartition(store, partition)).length > 0) {
            throw new DynamoDBUniversalComponentSchemaDriftError(
              `Component ${schema.id} contains rows without a catalog`,
            );
          }
        }
        await putCatalog(store, schema, latest);
      } else {
        const previous = schema.versions.find(
          ({ version }) => version === decision.fromVersion,
        )!;
        assertCatalogVersion(schema, catalog, previous);
        const rows = await loadRows(store, schema, previous);
        for (const target of schema.versions.slice(
          schema.versions.indexOf(previous) + 1,
        )) {
          for (const table of target.tables) {
            for (const row of rows.get(table.name) ?? []) {
              try {
                validateUniversalComponentRow(schema, {
                  row,
                  table: table.name,
                  version: target.version,
                });
              } catch (error) {
                throw new DynamoDBUniversalComponentStoredDataError(
                  `Invalid stored row for component table ${table.name}`,
                  { cause: error },
                );
              }
            }
          }
        }
        await replaceIndexes(store, schema, previous, latest, rows);
        await putCatalog(store, schema, latest);
      }
      await validatePhysicalState(store, schema, latest);
      await putMarker(store, schema, latest.version);
      readinessValidated.add(schema);
      return { changed: true, version: latest.version };
    },
  };
};

export const DYNAMODB_UPDATE_INDEX_NAME = "hot-updater-update-index";

export interface DynamoDBConfig extends DynamoDBClientConfig {
  readonly apiBasePath?: string;
  readonly cloudfrontDistributionId?: string;
  readonly shouldWaitForInvalidation?: boolean;
  readonly tableName: string;
}

export const dynamoDB = (config: DynamoDBConfig) => {
  const {
    apiBasePath = "/api/check-update",
    cloudfrontDistributionId,
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
  const plugin = createDatabasePlugin({
    name: "dynamoDB",
    plugin: () => ({
      ...createDynamoDBCrud(store, DYNAMODB_UPDATE_INDEX_NAME),
      getUpdateInfo: createDynamoDBGetUpdateInfo(
        store,
        DYNAMODB_UPDATE_INDEX_NAME,
      ),
      onUnmount: async () => {
        client.destroy();
        cloudFront?.destroy();
      },
    }),
  });
  const pluginWithInvalidation =
    cloudFront && cloudfrontDistributionId
      ? {
          ...plugin,
          onDatabaseUpdated: invalidateUpdateRoutes,
        }
      : plugin;
  const pluginWithPatchHydration = attachDatabasePluginPatchHydration(
    pluginWithInvalidation,
    {
      loadPatches: (ownerIds) => {
        const ownerId = ownerIds.length === 1 ? ownerIds[0] : undefined;
        return ownerId !== undefined
          ? queryCompleteOwnerPatches(
              store,
              DYNAMODB_UPDATE_INDEX_NAME,
              ownerId,
            )
          : queryCompleteOwnersPatches(
              store,
              DYNAMODB_UPDATE_INDEX_NAME,
              ownerIds,
            );
      },
    },
  );
  const pluginWithAggregateMutations = attachDatabasePluginAggregateMutations(
    pluginWithPatchHydration,
    createDynamoDBAggregateMutations(store),
  );
  return attachUniversalComponentDataAdapter(
    pluginWithAggregateMutations,
    (runtime) =>
      createDynamoDBUniversalComponentDataAdapter(
        store,
        runtime.database.onDatabaseUpdated,
      ),
  );
};
