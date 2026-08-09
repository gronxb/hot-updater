import {
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

import {
  DYNAMODB_MAX_BUNDLES,
  DYNAMODB_MAX_PATCHES,
  DYNAMODB_MAX_RELATIONSHIPS_PER_BUNDLE,
} from "./dynamodbDatabaseBounds";
import { itemKey } from "./dynamodbDatabaseRows";
import type { DynamoDBStore } from "./dynamodbDatabaseStore";

export {
  DYNAMODB_MAX_BUNDLES,
  DYNAMODB_MAX_PATCHES,
  DYNAMODB_MAX_RELATIONSHIPS_PER_BUNDLE,
} from "./dynamodbDatabaseBounds";

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

export class DynamoDBMetadataLimitError extends Error {
  readonly name = "DynamoDBMetadataLimitError";

  constructor(
    readonly model: "bundles" | "bundle_patches",
    options?: ErrorOptions,
  ) {
    const limit =
      model === "bundles" ? DYNAMODB_MAX_BUNDLES : DYNAMODB_MAX_PATCHES;
    super(
      `DynamoDB ${model} metadata limit of ${limit} has been reached`,
      options,
    );
  }
}

export class DynamoDBRelationshipLimitError extends Error {
  readonly name = "DynamoDBRelationshipLimitError";

  constructor(readonly bundleId: string) {
    super(
      `DynamoDB bundle "${bundleId}" exceeds the ${DYNAMODB_MAX_RELATIONSHIPS_PER_BUNDLE} patch relationship limit`,
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
    const limit =
      model === "bundles" ? DYNAMODB_MAX_BUNDLES : DYNAMODB_MAX_PATCHES;
    names[`#${name}`] = name;
    values[`:${valueName}Delta`] = change;
    updates.push(`#${name} :${valueName}Delta`);
    if (change > 0) {
      values[`:${valueName}Ceiling`] = limit - change;
      conditions.push(
        `(attribute_not_exists(#${name}) OR #${name} <= :${valueName}Ceiling)`,
      );
    } else {
      values[`:${valueName}Removal`] = -change;
      conditions.push(`#${name} >= :${valueName}Removal`);
    }
  }

  return {
    Update: {
      TableName: store.tableName,
      Key: { pk: "_hot-updater", sk: "limits.metadata" },
      UpdateExpression: `ADD ${updates.join(", ")}`,
      ConditionExpression: conditions.join(" AND "),
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
  if (delta > 0) {
    names["#relationCount"] = "relation_count";
    values[":relationDelta"] = delta;
    values[":relationCeiling"] = DYNAMODB_MAX_RELATIONSHIPS_PER_BUNDLE - delta;
    condition +=
      " AND (attribute_not_exists(#relationCount) OR #relationCount <= :relationCeiling)";
    additions.push("#relationCount :relationDelta");
  } else if (delta < 0) {
    names["#relationCount"] = "relation_count";
    values[":relationDelta"] = delta;
    values[":relationRemoval"] = -delta;
    condition += " AND #relationCount >= :relationRemoval";
    additions.push("#relationCount :relationDelta");
  }
  if (ownedPatchDelta !== 0) {
    names["#ownedPatchCount"] = "owned_patch_count";
    values[":ownedPatchDelta"] = ownedPatchDelta;
    additions.push("#ownedPatchCount :ownedPatchDelta");
    if (ownedPatchDelta > 0) {
      values[":ownedPatchCeiling"] =
        DYNAMODB_MAX_RELATIONSHIPS_PER_BUNDLE - ownedPatchDelta;
      condition +=
        " AND (attribute_not_exists(#ownedPatchCount) OR #ownedPatchCount <= :ownedPatchCeiling)";
    } else {
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

const isLimitCancellation = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const reasons = Reflect.get(error, "CancellationReasons");
  return (
    Array.isArray(reasons) &&
    Reflect.get(reasons[0] ?? {}, "Code") === "ConditionalCheckFailed"
  );
};

export const commitDynamoDBTransaction = async (
  store: DynamoDBStore,
  actions: readonly DynamoDBTransactItem[],
  limitedModel?: "bundles" | "bundle_patches",
): Promise<void> => {
  if (actions.length > 100) {
    throw new DynamoDBTransactionLimitError(actions.length);
  }
  try {
    await store.client.send(
      new TransactWriteCommand({ TransactItems: [...actions] }),
    );
  } catch (error) {
    if (limitedModel && isLimitCancellation(error)) {
      throw new DynamoDBMetadataLimitError(limitedModel, { cause: error });
    }
    throw error;
  }
};
