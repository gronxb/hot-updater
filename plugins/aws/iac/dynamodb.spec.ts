import { InitError } from "@hot-updater/cli-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTable: vi.fn(),
  describeContinuousBackups: vi.fn(),
  describeTable: vi.fn(),
  getItem: vi.fn(),
  putItem: vi.fn(),
  query: vi.fn(),
  transactWriteItems: vi.fn(),
  updateItem: vi.fn(),
  updateContinuousBackups: vi.fn(),
  waitUntilTableExists: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDB: vi.fn(function DynamoDB() {
    return {
      createTable: mocks.createTable,
      describeContinuousBackups: mocks.describeContinuousBackups,
      describeTable: mocks.describeTable,
      getItem: mocks.getItem,
      putItem: mocks.putItem,
      query: mocks.query,
      transactWriteItems: mocks.transactWriteItems,
      updateItem: mocks.updateItem,
      updateContinuousBackups: mocks.updateContinuousBackups,
    };
  }),
  waitUntilTableExists: mocks.waitUntilTableExists,
}));

import { DYNAMODB_UPDATE_INDEX_NAME } from "../src/dynamoDB";
import { DynamoDBManager } from "./dynamodb";

const compatibleTable = {
  BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
  OnDemandThroughput: {
    MaxReadRequestUnits: 4_000,
    MaxWriteRequestUnits: 100,
  },
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" },
    { AttributeName: "sk", AttributeType: "S" },
    { AttributeName: "gsi1pk", AttributeType: "S" },
    { AttributeName: "gsi1sk", AttributeType: "S" },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: DYNAMODB_UPDATE_INDEX_NAME,
      KeySchema: [
        { AttributeName: "gsi1pk", KeyType: "HASH" },
        { AttributeName: "gsi1sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
      OnDemandThroughput: {
        MaxReadRequestUnits: 4_000,
        MaxWriteRequestUnits: 100,
      },
    },
  ],
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" },
    { AttributeName: "sk", KeyType: "RANGE" },
  ],
} as const;

describe("DynamoDBManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.describeContinuousBackups.mockResolvedValue({
      ContinuousBackupsDescription: {
        PointInTimeRecoveryDescription: {
          PointInTimeRecoveryStatus: "DISABLED",
        },
      },
    });
    mocks.updateContinuousBackups.mockResolvedValue({});
    mocks.getItem.mockResolvedValue({});
    mocks.putItem.mockResolvedValue({});
    mocks.query.mockResolvedValue({ Items: [] });
    mocks.transactWriteItems.mockResolvedValue({});
    mocks.updateItem.mockResolvedValue({});
  });

  it("creates an on-demand metadata table with the update index", async () => {
    // Given
    mocks.describeTable.mockRejectedValue({
      name: "ResourceNotFoundException",
    });
    mocks.createTable.mockResolvedValue({});
    mocks.waitUntilTableExists.mockResolvedValue({ state: "SUCCESS" });
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.ensureTable("hot-updater-metadata");

    // Then
    expect(mocks.createTable).toHaveBeenCalledWith(
      expect.objectContaining({
        BillingMode: "PAY_PER_REQUEST",
        DeletionProtectionEnabled: true,
        TableName: "hot-updater-metadata",
        OnDemandThroughput: {
          MaxReadRequestUnits: 4_000,
          MaxWriteRequestUnits: 100,
        },
        GlobalSecondaryIndexes: [
          expect.objectContaining({ IndexName: DYNAMODB_UPDATE_INDEX_NAME }),
        ],
      }),
    );
    expect(mocks.updateContinuousBackups).toHaveBeenCalledWith({
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      TableName: "hot-updater-metadata",
    });
  });

  it("reuses a table with the managed key and index schema", async () => {
    // Given
    mocks.describeTable.mockResolvedValue({ Table: compatibleTable });
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.ensureTable("hot-updater-metadata");

    // Then
    expect(mocks.createTable).not.toHaveBeenCalled();
    expect(mocks.updateContinuousBackups).toHaveBeenCalledWith(
      expect.objectContaining({ TableName: "hot-updater-metadata" }),
    );
  });

  it("rejects an existing table with an incompatible schema", async () => {
    // Given
    mocks.describeTable.mockResolvedValue({
      Table: {
        BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
        OnDemandThroughput: {
          MaxReadRequestUnits: 4_000,
          MaxWriteRequestUnits: 100,
        },
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      },
    });
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    const setup = manager.ensureTable("existing-table");

    // Then
    await expect(setup).rejects.toMatchObject({
      name: "DynamoDBTableSchemaError",
      tableName: "existing-table",
    });
    expect(mocks.createTable).not.toHaveBeenCalled();
  });

  it("reports the next action when table access is denied", async () => {
    // Given
    const accessDenied = new Error(
      "User cannot perform dynamodb:DescribeTable on table/hot-updater",
    );
    accessDenied.name = "AccessDeniedException";
    mocks.describeTable.mockRejectedValue(accessDenied);
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    const error = await manager
      .ensureTable("hot-updater")
      .catch((error) => Promise.resolve(error));

    // Then
    expect(error).toBeInstanceOf(InitError);
    expect(error).toMatchObject({
      cause: accessDenied,
      name: "DynamoDBPermissionError",
      region: "ap-northeast-2",
      requiredAction: "dynamodb:DescribeTable",
      tableName: "hot-updater",
    });
    expect(error).toHaveProperty(
      "message",
      expect.stringMatching(
        /AmazonDynamoDBFullAccess_v2[\s\S]+hot-updater init/,
      ),
    );
  });

  it("rejects an existing table with non-string key attributes", async () => {
    // Given
    mocks.describeTable.mockResolvedValue({
      Table: {
        ...compatibleTable,
        AttributeDefinitions: compatibleTable.AttributeDefinitions.map(
          (definition) =>
            definition.AttributeName === "gsi1sk"
              ? { ...definition, AttributeType: "N" }
              : definition,
        ),
      },
    });
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    const setup = manager.ensureTable("existing-table");

    // Then
    await expect(setup).rejects.toMatchObject({
      name: "DynamoDBTableSchemaError",
      tableName: "existing-table",
    });
  });

  it("backfills one claimed channel and channel_id for legacy bundles", async () => {
    // Given
    mocks.describeTable.mockResolvedValue({ Table: compatibleTable });
    mocks.query
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Items: [legacyBundleItem("bundle-1", "Production")],
        LastEvaluatedKey: {
          pk: { S: "bundles" },
          sk: { S: "bundle-1" },
        },
      })
      .mockResolvedValueOnce({
        Items: [legacyBundleItem("bundle-2", "Production")],
      });
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.ensureTable("hot-updater-metadata");

    // Then
    expect(mocks.transactWriteItems).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        ExclusiveStartKey: {
          pk: { S: "bundles" },
          sk: { S: "bundle-1" },
        },
      }),
    );
    const transaction = mocks.transactWriteItems.mock.calls[0]?.[0];
    const claimId = transaction?.TransactItems?.[0]?.Put?.Item?.channel_id?.S;
    expect(claimId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(transaction?.TransactItems).toEqual([
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: {
            pk: { S: "_hot-updater#channel-names" },
            sk: { S: "Production" },
            channel_id: { S: claimId },
          },
        }),
      }),
      expect.objectContaining({
        Put: expect.objectContaining({
          Item: {
            pk: { S: "channels" },
            sk: { S: claimId },
            version: { N: "1" },
            reference_count: { N: "0" },
            row: {
              M: { id: { S: claimId }, name: { S: "Production" } },
            },
          },
        }),
      }),
    ]);
    expect(mocks.updateItem).toHaveBeenCalledTimes(3);
    expect(mocks.updateItem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        Key: { pk: { S: "bundles" }, sk: { S: "bundle-1" } },
        ExpressionAttributeValues: expect.objectContaining({
          ":channel": { S: "Production" },
          ":channelId": { S: claimId },
        }),
      }),
    );
    expect(mocks.updateItem).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        Key: { pk: { S: "bundles" }, sk: { S: "bundle-2" } },
        ExpressionAttributeValues: expect.objectContaining({
          ":channelId": { S: claimId },
        }),
      }),
    );
    expect(mocks.updateItem).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        Key: { pk: { S: "channels" }, sk: { S: claimId } },
        ExpressionAttributeValues: expect.objectContaining({
          ":referenceCount": { N: "2" },
        }),
      }),
    );
  });

  it("reuses a canonical claim without rewriting migrated bundles", async () => {
    // Given
    const channel = channelItem("channel-production", "production");
    mocks.describeTable.mockResolvedValue({ Table: compatibleTable });
    mocks.query
      .mockResolvedValueOnce({ Items: [channel] })
      .mockResolvedValueOnce({
        Items: [
          legacyBundleItem("bundle-1", "production", "channel-production"),
        ],
      });
    mocks.getItem
      .mockResolvedValueOnce({
        Item: {
          pk: { S: "_hot-updater#channel-names" },
          sk: { S: "production" },
          channel_id: { S: "channel-production" },
        },
      })
      .mockResolvedValueOnce({ Item: channel });
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.ensureTable("hot-updater-metadata");

    // Then
    expect(mocks.transactWriteItems).not.toHaveBeenCalled();
    expect(mocks.putItem).not.toHaveBeenCalled();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it("registers an unreferenced channel so empty channels remain reusable", async () => {
    // Given
    const channel = channelItem("channel-preview", "preview");
    mocks.describeTable.mockResolvedValue({ Table: compatibleTable });
    mocks.query
      .mockResolvedValueOnce({ Items: [channel] })
      .mockResolvedValueOnce({ Items: [] });
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.ensureTable("hot-updater-metadata");

    // Then
    expect(mocks.putItem).toHaveBeenCalledWith(
      expect.objectContaining({
        Item: {
          pk: { S: "_hot-updater#channel-names" },
          sk: { S: "preview" },
          channel_id: { S: "channel-preview" },
        },
      }),
    );
    expect(mocks.transactWriteItems).not.toHaveBeenCalled();
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it("rejects a migrated bundle whose channel_id names another channel", async () => {
    // Given
    const channel = channelItem("channel-production", "production");
    mocks.describeTable.mockResolvedValue({ Table: compatibleTable });
    mocks.query
      .mockResolvedValueOnce({ Items: [channel] })
      .mockResolvedValueOnce({
        Items: [legacyBundleItem("bundle-1", "production", "channel-staging")],
      });
    mocks.getItem
      .mockResolvedValueOnce({
        Item: {
          pk: { S: "_hot-updater#channel-names" },
          sk: { S: "production" },
          channel_id: { S: "channel-production" },
        },
      })
      .mockResolvedValueOnce({ Item: channel });
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    const migration = manager.ensureTable("hot-updater-metadata");

    // Then
    await expect(migration).rejects.toMatchObject({
      name: "DynamoDBChannelMigrationError",
      message: expect.stringContaining("mismatched channel_id"),
    });
  });
});

const channelItem = (
  id: string,
  name: string,
  referenceCount = name === "production" ? 1 : 0,
) => ({
  pk: { S: "channels" },
  sk: { S: id },
  version: { N: "1" },
  reference_count: { N: String(referenceCount) },
  row: { M: { id: { S: id }, name: { S: name } } },
});

const legacyBundleItem = (id: string, channel: string, channelId?: string) => ({
  pk: { S: "bundles" },
  sk: { S: id },
  version: { N: "1" },
  row: {
    M: {
      id: { S: id },
      channel: { S: channel },
      ...(channelId ? { channel_id: { S: channelId } } : {}),
    },
  },
});
