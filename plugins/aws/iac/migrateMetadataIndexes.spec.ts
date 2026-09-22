import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { bundleToRow } from "@hot-updater/plugin-core";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, expect, it } from "vitest";

import { toDynamoDBBundleItem } from "../src/dynamoDB";
import {
  ensureMetadataIndexes,
  metadataIndexPartition,
} from "../src/dynamoDBMetadataIndexes";
import { migrateDynamoDBMetadataIndexes } from "./migrateMetadataIndexes";

const mock = mockClient(DynamoDBDocumentClient);
const store = {
  client: mock as unknown as DynamoDBDocumentClient,
  tableName: "metadata",
};
beforeEach(() => {
  mock.reset();
  mock.on(GetCommand).resolves({});
});

it("refuses to scan populated metadata to repair an absent request-time index", async () => {
  mock.on(QueryCommand).resolves({ Count: 1 });
  await expect(ensureMetadataIndexes(store)).rejects.toThrow("upgrade");
  expect(mock.commandCalls(QueryCommand)).toHaveLength(1);
  expect(mock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
    Select: "COUNT",
    Limit: 1,
  });
});

it("explicitly upgrades every metadata page and marks completion only after writes", async () => {
  const row = bundleToRow({
    id: "bundle",
    platform: "ios",
    manifestFileHash: "hash",
    gitCommitHash: null,
    manifestStorageUri: "storage://bundle",
    assetBaseStorageUri: "storage://assets",
  });
  mock.on(QueryCommand).callsFake((input) =>
    input.ExpressionAttributeValues[":pk"] !== "bundles"
      ? { Items: [] }
      : input.ExclusiveStartKey === undefined
        ? {
            Items: [toDynamoDBBundleItem(row)],
            LastEvaluatedKey: { pk: "bundles", sk: row.id },
          }
        : { Items: [toDynamoDBBundleItem({ ...row, id: "bundle-2" })] },
  );
  mock.on(BatchWriteCommand).resolves({});
  mock.on(TransactWriteCommand).resolves({});
  await migrateDynamoDBMetadataIndexes(store);
  expect(mock.commandCalls(QueryCommand)).toHaveLength(4);
  expect(
    mock.commandCalls(BatchWriteCommand)[0]?.args[0].input.RequestItems
      ?.metadata?.[0]?.PutRequest?.Item,
  ).toMatchObject({
    pk: metadataIndexPartition("bundles", "platform", "ios"),
    sk: "bundle",
    target_pk: "bundles",
  });
  expect(
    mock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Update: expect.objectContaining({
          ExpressionAttributeValues: { ":bundles": 2, ":patches": 0 },
        }),
      }),
    ]),
  );
});

it("does not mark a failed backfill as ready", async () => {
  mock.on(QueryCommand).rejects(new Error("read failed"));
  await expect(migrateDynamoDBMetadataIndexes(store)).rejects.toThrow(
    "read failed",
  );
  expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
});
