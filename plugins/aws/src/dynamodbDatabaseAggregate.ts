import {
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type {
  BundlePatchRow,
  BundleRow,
  DatabasePluginAggregateMutations,
} from "@hot-updater/plugin-core";

import { DynamoDBTransactionLimitError } from "./dynamodbDatabaseCrud";
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
  loadBundleItems,
  loadPatchItems,
  type DynamoDBStore,
} from "./dynamodbDatabaseStore";

type TransactItem = NonNullable<
  TransactWriteCommandInput["TransactItems"]
>[number];

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

const conditionBundleExists = (
  store: DynamoDBStore,
  bundleId: string,
): TransactItem => ({
  ConditionCheck: {
    TableName: store.tableName,
    Key: itemKey("bundles", bundleId),
    ConditionExpression: "attribute_exists(#pk)",
    ExpressionAttributeNames: { "#pk": "pk" },
  },
});

const putNewBundle = (store: DynamoDBStore, row: BundleRow): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: toDynamoDBBundleItem(row),
    ConditionExpression: "attribute_not_exists(#pk)",
    ExpressionAttributeNames: { "#pk": "pk" },
  },
});

const putUpdatedBundle = (
  store: DynamoDBStore,
  current: DynamoDBBundleItem,
  row: BundleRow,
): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: toDynamoDBBundleItem(row, current.version + 1),
    ConditionExpression: "#version = :currentVersion",
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: { ":currentVersion": current.version },
  },
});

const putPatch = (
  store: DynamoDBStore,
  row: BundlePatchRow,
  current: DynamoDBPatchItem | undefined,
): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: toDynamoDBPatchItem(row, (current?.version ?? 0) + 1),
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
): TransactItem => ({
  Delete: {
    TableName: store.tableName,
    Key: itemKey(item.pk, item.sk),
    ConditionExpression: "#version = :currentVersion",
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: { ":currentVersion": item.version },
  },
});

const referenceChecks = (
  store: DynamoDBStore,
  bundleId: string,
  patches: readonly BundlePatchRow[],
): TransactItem[] =>
  [
    ...new Set(
      patches.flatMap((patch) =>
        patch.base_bundle_id === bundleId ? [] : [patch.base_bundle_id],
      ),
    ),
  ].map((baseBundleId) => conditionBundleExists(store, baseBundleId));

const commit = async (
  store: DynamoDBStore,
  actions: readonly TransactItem[],
): Promise<void> => {
  if (actions.length > 100) {
    throw new DynamoDBTransactionLimitError(actions.length);
  }
  await store.client.send(
    new TransactWriteCommand({ TransactItems: [...actions] }),
  );
};

export const createDynamoDBAggregateMutations = (
  store: DynamoDBStore,
): DatabasePluginAggregateMutations => ({
  async insertBundleWithPatches({ bundle, patches }): Promise<void> {
    assertUniquePatches(patches);
    await commit(store, [
      ...referenceChecks(store, bundle.id, patches),
      putNewBundle(store, bundle),
      ...patches.map((patch) => putPatch(store, patch, undefined)),
    ]);
  },
  async updateBundleWithPatches({
    bundleId,
    update,
    patches,
  }): Promise<boolean> {
    assertUniquePatches(patches);
    const bundle = (await loadBundleItems(store)).find(
      ({ sk }) => sk === bundleId,
    );
    if (!bundle) return false;
    const currentPatches = (await loadPatchItems(store)).filter(
      ({ row }) => row.bundle_id === bundleId,
    );
    const currentById = new Map(
      currentPatches.map((patch) => [patch.sk, patch]),
    );
    const nextIds = new Set(patches.map(({ id }) => id));
    await commit(store, [
      ...referenceChecks(store, bundleId, patches),
      putUpdatedBundle(store, bundle, { ...bundle.row, ...update }),
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
