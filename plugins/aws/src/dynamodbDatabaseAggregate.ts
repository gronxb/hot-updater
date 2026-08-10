import type {
  BundlePatchRow,
  BundleRow,
  DatabasePluginAggregateMutations,
} from "@hot-updater/plugin-core";

import { boundedDynamoDBMetadataItem } from "./dynamodbDatabaseBounds";
import {
  itemKey,
  toDynamoDBBundleItem,
  toDynamoDBPatchItem,
} from "./dynamodbDatabaseRows";
import type {
  DynamoDBBundleItem,
  DynamoDBPatchItem,
} from "./dynamodbDatabaseRows";
import {
  loadBundleItem,
  loadPatchItems,
  type DynamoDBStore,
} from "./dynamodbDatabaseStore";
import {
  commitDynamoDBTransaction,
  metadataUpdate,
  updateBundleRelation,
  type DynamoDBTransactItem,
} from "./dynamodbDatabaseTransactions";

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
