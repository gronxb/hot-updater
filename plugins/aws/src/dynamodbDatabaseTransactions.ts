import {
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

import { itemKey } from "./dynamodbDatabaseRows";
import type { DynamoDBStore } from "./dynamodbDatabaseStore";

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
