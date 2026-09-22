import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { commitDynamoDBTransaction } from "./dynamoDB";
import {
  metadataIndexItems,
  withMetadataIndexActions,
} from "./dynamoDBMetadataIndexes";

const client = mockClient(DynamoDBDocumentClient);
const store = () => ({
  tableName: "metadata",
  client: DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: "us-east-1" }),
  ),
});
const release = (id: string) => ({
  pk: "release-scope#channel#ios",
  sk: id,
  version: 7,
  row: {
    id,
    bundle_id: null,
    channel_id: "channel",
    enabled: false,
    platform: "ios",
    target_app_version: null,
    message: "before",
  },
});

describe("DynamoDB metadata projection write cost", () => {
  beforeEach(() => {
    client.reset();
    client
      .on(GetCommand)
      .callsFake(({ Key }) =>
        Key.sk === "metadata-indexes"
          ? { Item: { version: 1 } }
          : { Item: release(Key.sk) },
      );
    client.on(TransactWriteCommand).resolves({});
  });

  it("fits 20 message updates in one transaction without rewriting unchanged projections", async () => {
    const actions = Array.from({ length: 20 }, (_, index) => {
      const old = release(`release-${index}`);
      return {
        Put: {
          TableName: "metadata",
          Item: { ...old, version: 8, row: { ...old.row, message: "after" } },
          ConditionExpression: "#version = :version",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: { ":version": 7 },
        },
      };
    });
    await commitDynamoDBTransaction(store(), actions);
    expect(client.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(
      client.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems,
    ).toEqual(actions);
  });

  it("rewrites every affected residual payload when one indexed value changes", async () => {
    const old = release("release");
    const next = { ...old, row: { ...old.row, enabled: true } };
    const actions = await withMetadataIndexActions(store(), [
      { Put: { TableName: "metadata", Item: next } },
    ]);
    expect(actions).toHaveLength(7);
    const projections = actions.slice(1);
    expect(
      projections
        .filter((action) => action.Put)
        .map((action) => action.Put!.Item),
    ).toEqual(expect.arrayContaining(metadataIndexItems(next)));
    expect(projections.filter((action) => action.Delete)).toEqual([
      {
        Delete: {
          TableName: "metadata",
          Key: { pk: "_hot-updater#index#releases#enabled#false", sk: old.sk },
        },
      },
    ]);
  });

  it("updates target partitions when a release moves with the same index values", async () => {
    const old = release("release");
    const next = { ...old, pk: "release-scope#new-scope" };
    client.on(GetCommand, { Key: { pk: next.pk, sk: next.sk } }).resolves({});
    const canonical = [
      { Delete: { TableName: "metadata", Key: { pk: old.pk, sk: old.sk } } },
      { Put: { TableName: "metadata", Item: next } },
    ];
    const actions = await withMetadataIndexActions(store(), canonical);
    expect(actions).toHaveLength(7);
    expect(actions.slice(2).map((action) => action.Put?.Item)).toEqual(
      metadataIndexItems(next),
    );
  });

  it("creates and deletes all five projections including null-valued keys", async () => {
    const old = release("release");
    const deleted = await withMetadataIndexActions(store(), [
      { Delete: { TableName: "metadata", Key: { pk: old.pk, sk: old.sk } } },
    ]);
    expect(deleted.slice(1).map((action) => action.Delete?.Key)).toEqual(
      metadataIndexItems(old).map(({ pk, sk }) => ({ pk, sk })),
    );
    client.on(GetCommand, { Key: { pk: old.pk, sk: old.sk } }).resolves({});
    const inserted = await withMetadataIndexActions(store(), [
      { Put: { TableName: "metadata", Item: old } },
    ]);
    expect(inserted.slice(1).map((action) => action.Put?.Item)).toEqual(
      metadataIndexItems(old),
    );
  });
});
