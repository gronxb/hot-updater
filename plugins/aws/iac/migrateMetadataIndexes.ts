import {
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  batchGetDynamoDBItems,
  parseDynamoDBItem,
  type DynamoDBStore,
} from "../src/dynamoDB";
import { metadataIndexItems } from "../src/dynamoDBMetadataIndexes";

/** One-time v1 metadata upgrade. Stop metadata writers until this completes. */
export const migrateDynamoDBMetadataIndexes = async (
  store: DynamoDBStore,
): Promise<void> => {
  const markerKey = { pk: "_hot-updater", sk: "metadata-indexes" };
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
  const counts = { bundles: 0, patches: 0 };
  for (const partition of [
    "bundles",
    "bundle_patches",
    "_hot-updater#release-scope-by-id",
  ]) {
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await store.client.send(
        new QueryCommand({
          TableName: store.tableName,
          ConsistentRead: true,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames: { "#pk": "pk" },
          ExpressionAttributeValues: { ":pk": partition },
          Limit: 100,
          ExclusiveStartKey: cursor,
        }),
      );
      const items =
        partition === "_hot-updater#release-scope-by-id"
          ? await batchGetDynamoDBItems(
              store,
              (page.Items ?? []).map((item) => {
                if (
                  typeof item.scope_key !== "string" ||
                  typeof item.sk !== "string"
                )
                  throw new Error(
                    "Invalid release locator during metadata upgrade",
                  );
                return { pk: `release-scope#${item.scope_key}`, sk: item.sk };
              }),
            )
          : (page.Items ?? []);
      if (
        partition === "_hot-updater#release-scope-by-id" &&
        items.length !== (page.Items ?? []).length
      )
        throw new Error("Missing release during metadata upgrade");
      for (const item of items) parseDynamoDBItem(item);
      if (partition === "bundles") counts.bundles += items.length;
      if (partition === "bundle_patches") counts.patches += items.length;
      const projections = items.flatMap(metadataIndexItems);
      // Old release locators did not carry the id used by native cursor filters.
      if (partition === "_hot-updater#release-scope-by-id")
        projections.push(
          ...(page.Items ?? []).map((item) => ({
            ...item,
            target_pk: `release-scope#${item.scope_key}`,
            row: { id: item.sk },
          })),
        );
      for (let offset = 0; offset < projections.length; offset += 25) {
        let requests = projections
          .slice(offset, offset + 25)
          .map((item) => ({ PutRequest: { Item: item } }));
        for (let attempt = 0; requests.length > 0; attempt++) {
          if (attempt === 5)
            throw new Error(
              "DynamoDB metadata index upgrade has unprocessed writes; retry while writers remain stopped",
            );
          const response = await store.client.send(
            new BatchWriteCommand({
              RequestItems: { [store.tableName]: requests },
            }),
          );
          requests = (response.UnprocessedItems?.[store.tableName] ?? []).map(
            (request) => {
              if (request.PutRequest?.Item === undefined)
                throw new Error("Invalid metadata index write response");
              return { PutRequest: { Item: request.PutRequest.Item } };
            },
          );
          if (requests.length > 0)
            await new Promise((resolve) =>
              setTimeout(resolve, 50 * 2 ** attempt),
            );
        }
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor !== undefined);
  }
  await store.client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: store.tableName,
            Item: { ...markerKey, version: 1 },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Update: {
            TableName: store.tableName,
            Key: { pk: "_hot-updater", sk: "limits.metadata" },
            UpdateExpression: "SET bundles = :bundles, patches = :patches",
            ExpressionAttributeValues: {
              ":bundles": counts.bundles,
              ":patches": counts.patches,
            },
          },
        },
      ],
    }),
  );
};
