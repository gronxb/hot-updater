import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DatabaseModel } from "@hot-updater/plugin-core";

import { batchGetDynamoDBItems } from "./dynamodbDatabaseBatchGet";
import { boundedDynamoDBMetadataItem } from "./dynamodbDatabaseBounds";
import {
  itemKey,
  parseDynamoDBItem,
  type DynamoDBBundleItem,
  type DynamoDBPatchItem,
} from "./dynamodbDatabaseRows";
import type { DynamoDBStore } from "./dynamodbDatabaseStore";

const parseItem = (item: Record<string, unknown>) =>
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
    .map(parseItem)
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
    .map(parseItem)
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
