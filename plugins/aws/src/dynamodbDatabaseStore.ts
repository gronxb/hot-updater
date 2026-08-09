import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { BundleRow, DatabaseModel } from "@hot-updater/plugin-core";

import { boundedDynamoDBMetadataItem } from "./dynamodbDatabaseBounds";
import type {
  DynamoDBBundleItem,
  DynamoDBItem,
  DynamoDBPatchItem,
} from "./dynamodbDatabaseRows";
import {
  bundleUpdatePartition,
  parseDynamoDBItem,
  patchOwnerPartition,
  itemKey,
} from "./dynamodbDatabaseRows";

export type DynamoDBStore = {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
};

const parseItem = (item: Record<string, unknown>): DynamoDBItem =>
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
    const pageItems = (page.Items ?? []).map(parseItem);
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
    for (const item of (page.Items ?? []).map(parseItem)) {
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
  return Item === undefined ? undefined : parseItem(Item);
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
