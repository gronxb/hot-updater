import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { bundleToRow } from "@hot-updater/plugin-core";
import { mockClient } from "aws-sdk-client-mock";
import { expect, it } from "vitest";

import { dynamoDB, toDynamoDBBundleItem } from "./dynamoDB";
import { metadataIndexItems } from "./dynamoDBMetadataIndexes";

it("retries a non-indexed bundle update after a competing indexed-field write without losing the winning projection", async () => {
  const client = mockClient(DynamoDBDocumentClient);
  const initial = toDynamoDBBundleItem(
    bundleToRow({
      id: "00000000-0000-7000-8000-000000000001",
      platform: "ios",
      gitCommitHash: null,
      metadata: {},
      manifestStorageUri: "storage://manifest.json",
      manifestFileHash: "before",
      assetBaseStorageUri: "storage://assets",
    }),
    7,
  );
  const key = (item: Record<string, unknown>) =>
    JSON.stringify([item.pk, item.sk]);
  const items = new Map<string, Record<string, unknown>>(
    [initial, ...metadataIndexItems(initial)].map((item) => [key(item), item]),
  );
  const plugin = () => dynamoDB({ region: "us-east-1", tableName: "metadata" });
  let interleave = true;
  let conflicts = 0;
  client
    .on(GetCommand)
    .callsFake(({ Key }) => ({
      Item:
        Key.sk === "metadata-indexes"
          ? { version: 1 }
          : structuredClone(items.get(key(Key))),
    }));
  client.on(BatchGetCommand).callsFake(({ RequestItems }) => ({
    Responses: {
      metadata: RequestItems.metadata.Keys.flatMap(
        (item: Record<string, unknown>) => {
          const found = items.get(key(item));
          return found === undefined ? [] : [structuredClone(found)];
        },
      ),
    },
  }));
  client.on(TransactWriteCommand).callsFake(async ({ TransactItems }) => {
    if (interleave) {
      interleave = false;
      // A has compiled its unchanged iOS projection. Let public writer B move it
      // to Android before the transport evaluates A's canonical condition.
      await expect(
        plugin().commit({
          changes: [
            {
              model: "bundles",
              operation: "update",
              where: { id: initial.sk },
              update: { platform: "android" },
            },
          ],
        }),
      ).resolves.toEqual({ committed: true });
    }
    for (const action of TransactItems) {
      const put = action.Put;
      if (put?.Item.pk !== "bundles") continue;
      expect(put.ConditionExpression).toBe("#version = :currentVersion");
      expect(put.ExpressionAttributeNames["#version"]).toBe("version");
      if (
        items.get(key(put.Item))?.version !==
        put.ExpressionAttributeValues[":currentVersion"]
      ) {
        conflicts += 1;
        throw Object.assign(new Error("canonical version changed"), {
          name: "TransactionCanceledException",
        });
      }
    }
    // All conditions pass before applying any canonical or projection writes.
    for (const action of TransactItems) {
      if (action.Put)
        items.set(key(action.Put.Item), structuredClone(action.Put.Item));
      if (action.Delete) items.delete(key(action.Delete.Key));
    }
    return {};
  });
  try {
    await expect(
      plugin().commit({
        changes: [
          {
            model: "bundles",
            operation: "update",
            where: { id: initial.sk },
            update: { manifest_file_hash: "after" },
          },
        ],
      }),
    ).resolves.toEqual({ committed: true });
    expect(conflicts).toBe(1);
    expect(client.commandCalls(TransactWriteCommand)).toHaveLength(3);
    const final = items.get(key(initial))!;
    expect(final).toMatchObject({
      version: 9,
      row: { platform: "android", manifest_file_hash: "after" },
    });
    expect(
      [...items.values()].filter((item) =>
        String(item.pk).startsWith("_hot-updater#index#"),
      ),
    ).toEqual(metadataIndexItems(final));
  } finally {
    client.restore();
  }
});
