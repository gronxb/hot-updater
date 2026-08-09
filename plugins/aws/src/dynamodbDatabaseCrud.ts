import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type {
  BundlePatchRow,
  BundleRow,
  DatabaseImplementationResult,
  DatabasePluginImplementation,
} from "@hot-updater/plugin-core";

import {
  countDistinctDynamoDBRows,
  matchesDynamoDBWhere,
  queryDynamoDBRows,
} from "./dynamodbDatabaseQuery";
import {
  itemKey,
  toDynamoDBBundleItem,
  toDynamoDBPatchItem,
} from "./dynamodbDatabaseRows";
import type { DynamoDBItem } from "./dynamodbDatabaseRows";
import {
  loadBundleItems,
  loadPatchItems,
  type DynamoDBStore,
} from "./dynamodbDatabaseStore";

export class DynamoDBTransactionLimitError extends Error {
  readonly name = "DynamoDBTransactionLimitError";

  constructor(readonly actionCount: number) {
    super(
      `DynamoDB transaction requires ${actionCount} actions; maximum is 100`,
    );
  }
}

class DynamoDBUnsupportedModelError extends Error {
  readonly name = "DynamoDBUnsupportedModelError";

  constructor() {
    super("DynamoDB received an unsupported database model");
  }
}

const assertTransactionSize = (actionCount: number): void => {
  if (actionCount > 100) throw new DynamoDBTransactionLimitError(actionCount);
};

const putItem = async (
  store: DynamoDBStore,
  item: DynamoDBItem,
): Promise<void> => {
  await store.client.send(
    new PutCommand({
      TableName: store.tableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "pk" },
    }),
  );
};

const createPatch = async (
  store: DynamoDBStore,
  row: BundlePatchRow,
): Promise<void> => {
  const bundleIds = [...new Set([row.bundle_id, row.base_bundle_id])];
  await store.client.send(
    new TransactWriteCommand({
      TransactItems: [
        ...bundleIds.map((bundleId) => ({
          ConditionCheck: {
            TableName: store.tableName,
            Key: itemKey("bundles", bundleId),
            ConditionExpression: "attribute_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
          },
        })),
        {
          Put: {
            TableName: store.tableName,
            Item: toDynamoDBPatchItem(row),
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "pk" },
          },
        },
      ],
    }),
  );
};

const replaceBundle = async (
  store: DynamoDBStore,
  currentVersion: number,
  row: BundleRow,
): Promise<void> => {
  await store.client.send(
    new PutCommand({
      TableName: store.tableName,
      Item: toDynamoDBBundleItem(row, currentVersion + 1),
      ConditionExpression: "#version = :currentVersion",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":currentVersion": currentVersion },
    }),
  );
};

const deleteItems = async (
  store: DynamoDBStore,
  items: readonly DynamoDBItem[],
): Promise<void> => {
  assertTransactionSize(items.length);
  if (items.length === 0) return;
  await store.client.send(
    new TransactWriteCommand({
      TransactItems: items.map((item) => ({
        Delete: {
          TableName: store.tableName,
          Key: itemKey(item.pk, item.sk),
        },
      })),
    }),
  );
};

const distinctFields = (
  fields: readonly string[] | undefined,
): readonly string[] | undefined => fields;

export const createDynamoDBCrud = (
  store: DynamoDBStore,
): DatabasePluginImplementation => ({
  async create(input): Promise<DatabaseImplementationResult> {
    switch (input.model) {
      case "bundles":
        await putItem(store, toDynamoDBBundleItem(input.data));
        return input.data;
      case "bundle_patches":
        await createPatch(store, input.data);
        return input.data;
    }
    throw new DynamoDBUnsupportedModelError();
  },
  async update(input): Promise<DatabaseImplementationResult | null> {
    const items = await loadBundleItems(store);
    const current = items.find(({ row }) =>
      matchesDynamoDBWhere(row, input.where),
    );
    if (!current) return null;
    const updated = { ...current.row, ...input.update };
    await replaceBundle(store, current.version, updated);
    return updated;
  },
  async delete(input): Promise<void> {
    if (input.model === "bundle_patches") {
      const items = (await loadPatchItems(store)).filter(({ row }) =>
        matchesDynamoDBWhere(row, input.where),
      );
      await deleteItems(store, items);
      return;
    }
    const bundleItems = (await loadBundleItems(store)).filter(({ row }) =>
      matchesDynamoDBWhere(row, input.where),
    );
    const removedIds = new Set(bundleItems.map(({ sk }) => sk));
    const patchItems = (await loadPatchItems(store)).filter(
      ({ row }) =>
        removedIds.has(row.bundle_id) || removedIds.has(row.base_bundle_id),
    );
    await deleteItems(store, [...bundleItems, ...patchItems]);
  },
  async count(input): Promise<number> {
    switch (input.model) {
      case "bundles": {
        const rows = (await loadBundleItems(store))
          .map(({ row }) => row)
          .filter((row) => matchesDynamoDBWhere(row, input.where));
        return countDistinctDynamoDBRows(rows, distinctFields(input.distinct));
      }
      case "bundle_patches": {
        const rows = (await loadPatchItems(store))
          .map(({ row }) => row)
          .filter((row) => matchesDynamoDBWhere(row, input.where));
        return countDistinctDynamoDBRows(rows, distinctFields(input.distinct));
      }
    }
    throw new DynamoDBUnsupportedModelError();
  },
  async findOne(input): Promise<DatabaseImplementationResult | null> {
    switch (input.model) {
      case "bundles":
        return (
          (await loadBundleItems(store))
            .map(({ row }) => row)
            .find((row) => matchesDynamoDBWhere(row, input.where)) ?? null
        );
      case "bundle_patches":
        return (
          (await loadPatchItems(store))
            .map(({ row }) => row)
            .find((row) => matchesDynamoDBWhere(row, input.where)) ?? null
        );
    }
    throw new DynamoDBUnsupportedModelError();
  },
  async findMany(input): Promise<readonly DatabaseImplementationResult[]> {
    switch (input.model) {
      case "bundles":
        return queryDynamoDBRows(
          (await loadBundleItems(store)).map(({ row }) => row),
          input,
        );
      case "bundle_patches":
        return queryDynamoDBRows(
          (await loadPatchItems(store)).map(({ row }) => row),
          input,
        );
    }
    throw new DynamoDBUnsupportedModelError();
  },
});
