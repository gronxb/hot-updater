import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

import type { DynamoDBStore } from "./dynamoDB";

type Action = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
const markerKey = { pk: "_hot-updater", sk: "metadata-indexes" };
const fields = {
  bundles: ["platform"],
  bundle_patches: ["base_bundle_id"],
  releases: [
    "bundle_id",
    "channel_id",
    "enabled",
    "platform",
    "target_app_version",
  ],
} as const;
export type IndexedMetadataModel = keyof typeof fields;
export const metadataIndexPartition = (
  model: IndexedMetadataModel,
  field: string,
  value: unknown,
) => `_hot-updater#index#${model}#${field}#${JSON.stringify(value)}`;

export const metadataIndexItems = (
  item: Record<string, unknown> | undefined,
): Record<string, unknown>[] => {
  if (
    item === undefined ||
    typeof item.pk !== "string" ||
    typeof item.sk !== "string" ||
    typeof item.row !== "object" ||
    item.row === null
  )
    return [];
  const model = item.pk.startsWith("release-scope#") ? "releases" : item.pk;
  if (model !== "bundles" && model !== "bundle_patches" && model !== "releases")
    return [];
  const row = Object.fromEntries(
    ["id", ...fields[model]].map((key) => [
      key,
      Reflect.get(item.row as object, key),
    ]),
  );
  return fields[model].map((field) => ({
    pk: metadataIndexPartition(model, field, row[field]),
    sk: item.sk,
    target_pk: item.pk,
    row,
  }));
};

// Old data must be explicitly migrated. An absent projection is never repaired by
// scanning metadata in the request path, nor treated as an empty result.
export const ensureMetadataIndexes = async (
  store: DynamoDBStore,
): Promise<void> => {
  const { Item } = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: markerKey,
      ConsistentRead: true,
    }),
  );
  if (Item?.version === 1) return;
  if (Item !== undefined)
    throw new Error("Unsupported DynamoDB metadata index version");
  for (const pk of [
    "bundles",
    "bundle_patches",
    "_hot-updater#release-scope-by-id",
  ]) {
    const page = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": pk },
        Select: "COUNT",
        Limit: 1,
        ConsistentRead: true,
      }),
    );
    if ((page.Count ?? 0) > 0 || page.LastEvaluatedKey !== undefined)
      throw new Error(
        "DynamoDB metadata indexes are missing; rebuild them during the infrastructure upgrade before serving requests",
      );
  }
  await store.client.send(
    new PutCommand({
      TableName: store.tableName,
      Item: { ...markerKey, version: 1 },
    }),
  );
};

// Projection writes share the canonical row's transaction and version guard.
export const withMetadataIndexActions = async (
  store: DynamoDBStore,
  actions: readonly Action[],
): Promise<Action[]> => {
  const changes = actions.filter((action) => {
    const key = action.Put?.Item ?? action.Delete?.Key;
    const pk = key?.pk;
    return (
      typeof pk === "string" &&
      (pk === "bundles" ||
        pk === "bundle_patches" ||
        pk.startsWith("release-scope#"))
    );
  });
  if (changes.length === 0) return [...actions];
  await ensureMetadataIndexes(store);
  const projected = new Map<string, Action>();
  // Remove old keys first, then put new keys (including moves between release scopes).
  for (const change of changes) {
    const key = change.Put?.Item ?? change.Delete?.Key;
    if (!key) continue;
    const { Item } = await store.client.send(
      new GetCommand({
        TableName: store.tableName,
        Key: { pk: key.pk, sk: key.sk },
        ConsistentRead: true,
      }),
    );
    for (const item of metadataIndexItems(Item))
      projected.set(JSON.stringify([item.pk, item.sk]), {
        Delete: {
          TableName: store.tableName,
          Key: { pk: item.pk, sk: item.sk },
        },
      });
  }
  for (const change of changes) {
    for (const item of metadataIndexItems(change.Put?.Item))
      projected.set(JSON.stringify([item.pk, item.sk]), {
        Put: { TableName: store.tableName, Item: item },
      });
  }
  return [...actions, ...projected.values()];
};
