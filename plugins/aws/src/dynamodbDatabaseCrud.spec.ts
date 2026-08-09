import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { bundleToRow } from "@hot-updater/plugin-core";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { createDynamoDBCrud } from "./dynamodbDatabaseCrud";
import {
  toDynamoDBBundleItem,
  toDynamoDBPatchItem,
} from "./dynamodbDatabaseRows";

const dynamodb = mockClient(DynamoDBDocumentClient);
const bundleId = "00000000-0000-0000-0000-000000000001";
const baseBundleId = "00000000-0000-0000-0000-000000000002";
const bundleRow = bundleToRow({
  id: bundleId,
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: "hash",
  gitCommitHash: null,
  message: null,
  channel: "production",
  storageUri: "storage://bundle.zip",
  targetAppVersion: "1.x",
  fingerprintHash: null,
  metadata: {},
});
const patchRow = {
  id: `${bundleId}:${baseBundleId}`,
  bundle_id: bundleId,
  base_bundle_id: baseBundleId,
  base_file_hash: "base-hash",
  patch_file_hash: "patch-hash",
  patch_storage_uri: "storage://patch.patch",
  order_index: 0,
} as const;

const createCrud = () => {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
      },
      region: "us-east-1",
    }),
  );
  return createDynamoDBCrud(
    { client, tableName: "hot-updater-metadata" },
    "hot-updater-update-index",
  );
};

describe("DynamoDB CRUD access patterns", () => {
  beforeEach(() => {
    dynamodb.reset();
  });

  it("uses a strongly consistent key read for an exact bundle id", async () => {
    // Given
    dynamodb.on(GetCommand).resolves({ Item: toDynamoDBBundleItem(bundleRow) });
    const crud = createCrud();

    // When
    const result = await crud.findOne({
      model: "bundles",
      where: [{ field: "id", operator: "eq", value: bundleId }],
    });

    // Then
    expect(result).toEqual(bundleRow);
    expect(dynamodb.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      ConsistentRead: true,
      Key: { pk: "bundles", sk: bundleId },
    });
    expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("preserves case-insensitive id matching outside the exact-key fast path", async () => {
    // Given
    dynamodb.on(QueryCommand).resolves({
      Items: [toDynamoDBBundleItem({ ...bundleRow, id: "BUNDLE-ID" })],
    });
    const crud = createCrud();

    // When
    const result = await crud.findOne({
      model: "bundles",
      where: [
        {
          field: "id",
          mode: "insensitive",
          operator: "eq",
          value: "bundle-id",
        },
      ],
    });

    // Then
    expect(result).toMatchObject({ id: "BUNDLE-ID" });
    expect(dynamodb.commandCalls(GetCommand)).toHaveLength(0);
    expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it("returns no rows and performs no read when the limit is zero", async () => {
    const result = await createCrud().findMany({
      model: "bundles",
      limit: 0,
      offset: 0,
      orderBy: [{ field: "id", direction: "asc" }],
    });

    expect(result).toEqual([]);
    expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("does not push an id cursor through an OR predicate", async () => {
    dynamodb.on(QueryCommand).resolves({
      Items: [toDynamoDBBundleItem({ ...bundleRow, id: "bundle-a" })],
    });

    await createCrud().findMany({
      model: "bundles",
      where: [
        { field: "id", operator: "gt", value: "bundle-z" },
        {
          connector: "OR",
          field: "channel",
          operator: "eq",
          value: "production",
        },
      ],
      limit: 100,
      offset: 0,
      orderBy: [{ field: "id", direction: "asc" }],
    });

    expect(
      dynamodb.commandCalls(QueryCommand)[0]?.args[0].input
        .KeyConditionExpression,
    ).toBe("#pk = :pk");
  });

  it("increments the bounded metadata counter in the create transaction", async () => {
    // Given
    dynamodb.on(TransactWriteCommand).resolves({});
    const crud = createCrud();

    // When
    await crud.create({ model: "bundles", data: bundleRow });

    // Then
    expect(
      dynamodb.commandCalls(TransactWriteCommand)[0]?.args[0].input
        .TransactItems?.[0]?.Update,
    ).toMatchObject({
      ConditionExpression:
        "(attribute_not_exists(#bundles) OR #bundles <= :bundleCeiling)",
      Key: { pk: "_hot-updater", sk: "limits.metadata" },
      UpdateExpression: "ADD #bundles :bundleDelta",
    });
  });

  it("locks both referenced bundles when creating a patch", async () => {
    // Given
    dynamodb.on(TransactWriteCommand).resolves({});
    const crud = createCrud();

    // When
    await crud.create({ model: "bundle_patches", data: patchRow });

    // Then
    const transaction =
      dynamodb.commandCalls(TransactWriteCommand)[0]?.args[0].input
        .TransactItems;
    expect(transaction).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Update: expect.objectContaining({
            Key: { pk: "bundles", sk: bundleId },
          }),
        }),
        expect.objectContaining({
          Update: expect.objectContaining({
            Key: { pk: "bundles", sk: baseBundleId },
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({ Item: toDynamoDBPatchItem(patchRow) }),
        }),
      ]),
    );
  });

  it("conditions deletes on every observed item version", async () => {
    // Given
    dynamodb.on(QueryCommand).resolves({
      Items: [toDynamoDBPatchItem(patchRow, 7)],
    });
    dynamodb.on(TransactWriteCommand).resolves({});
    const crud = createCrud();

    // When
    await crud.delete({
      model: "bundle_patches",
      where: [{ field: "id", operator: "eq", value: patchRow.id }],
    });

    // Then
    const deletion = dynamodb
      .commandCalls(TransactWriteCommand)[0]
      ?.args[0].input.TransactItems?.find((item) => item.Delete)?.Delete;
    expect(deletion).toMatchObject({
      ConditionExpression: "#version = :currentVersion",
      ExpressionAttributeValues: { ":currentVersion": 7 },
    });
  });
});
