import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { BundlePatchRow, BundleRow } from "@hot-updater/plugin-core";

import { boundedDynamoDBMetadataItem } from "./dynamodbDatabaseBounds";
import {
  itemKey,
  toDynamoDBBundleItem,
  toDynamoDBPatchItem,
  type DynamoDBBundleItem,
  type DynamoDBItem,
  type DynamoDBPatchItem,
} from "./dynamodbDatabaseRows";
import type { DynamoDBStore } from "./dynamodbDatabaseStore";
import {
  commitDynamoDBTransaction,
  metadataUpdate,
  updateBundleRelation,
  type DynamoDBTransactItem,
} from "./dynamodbDatabaseTransactions";

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
