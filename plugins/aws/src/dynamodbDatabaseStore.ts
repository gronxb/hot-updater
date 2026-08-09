import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  BundlePatchRow,
  BundleRow,
  DatabaseModel,
} from "@hot-updater/plugin-core";

import type {
  DynamoDBBundleItem,
  DynamoDBItem,
  DynamoDBPatchItem,
} from "./dynamodbDatabaseRows";
import {
  bundleUpdatePartition,
  parseDynamoDBItem,
  patchOwnerPartition,
} from "./dynamodbDatabaseRows";

export type DynamoDBStore = {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
};

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
    const pageItems = (page.Items ?? []).map(parseDynamoDBItem);
    items.push(...pageItems);
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
};

const loadModelItems = (
  store: DynamoDBStore,
  model: DatabaseModel,
): Promise<DynamoDBItem[]> =>
  queryItems(store, { partition: model, consistentRead: true });

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

export const queryOwnerPatches = async (
  store: DynamoDBStore,
  indexName: string,
  bundleId: string,
): Promise<BundlePatchRow[]> => {
  const items = await queryItems(store, {
    partition: patchOwnerPartition(bundleId),
    indexName,
  });
  return items
    .filter((item): item is DynamoDBPatchItem => item.pk === "bundle_patches")
    .map(({ row }) => row);
};
