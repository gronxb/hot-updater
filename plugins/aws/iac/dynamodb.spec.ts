import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTable: vi.fn(),
  describeTable: vi.fn(),
  getItem: vi.fn(),
  putItem: vi.fn(),
  describeTimeToLive: vi.fn(),
  describeContinuousBackups: vi.fn(),
  updateContinuousBackups: vi.fn(),
  updateTimeToLive: vi.fn(),
  waitUntilTableExists: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDB: vi.fn(function DynamoDB() {
    return {
      createTable: mocks.createTable,
      describeTable: mocks.describeTable,
      getItem: mocks.getItem,
      putItem: mocks.putItem,
      describeTimeToLive: mocks.describeTimeToLive,
      describeContinuousBackups: mocks.describeContinuousBackups,
      updateContinuousBackups: mocks.updateContinuousBackups,
      updateTimeToLive: mocks.updateTimeToLive,
    };
  }),
  waitUntilTableExists: mocks.waitUntilTableExists,
}));

import { DYNAMODB_UPDATE_INDEX_NAME } from "../src/dynamodbDatabase";
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
    mocks.getItem.mockResolvedValue({});
    mocks.putItem.mockResolvedValue({});
    mocks.describeTimeToLive.mockResolvedValue({
      TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" },
    });
    mocks.describeContinuousBackups.mockResolvedValue({
      ContinuousBackupsDescription: {
        PointInTimeRecoveryDescription: {
          PointInTimeRecoveryStatus: "DISABLED",
        },
      },
    });
    mocks.updateContinuousBackups.mockResolvedValue({});
    mocks.updateTimeToLive.mockResolvedValue({});
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
    expect(mocks.updateTimeToLive).toHaveBeenCalledWith({
      TableName: "hot-updater-metadata",
      TimeToLiveSpecification: {
        AttributeName: "expires_at_s",
        Enabled: true,
      },
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
    expect(mocks.putItem).toHaveBeenCalledWith(
      expect.objectContaining({
        ConditionExpression: "attribute_not_exists(#pk)",
      }),
    );
    expect(mocks.updateContinuousBackups).toHaveBeenCalledWith(
      expect.objectContaining({ TableName: "hot-updater-metadata" }),
    );
  });

  it("does not reconfigure TTL while the managed attribute is enabling", async () => {
    // Given
    mocks.describeTable.mockResolvedValue({ Table: compatibleTable });
    mocks.describeTimeToLive.mockResolvedValue({
      TimeToLiveDescription: {
        AttributeName: "expires_at_s",
        TimeToLiveStatus: "ENABLING",
      },
    });
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.ensureTable("hot-updater-metadata");

    // Then
    expect(mocks.updateTimeToLive).not.toHaveBeenCalled();
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
    expect(mocks.putItem).not.toHaveBeenCalled();
  });

  it("rejects a table with a future Analytics schema marker", async () => {
    mocks.describeTable.mockResolvedValue({ Table: compatibleTable });
    mocks.getItem.mockResolvedValue({ Item: { value: { S: "4" } } });
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await expect(
      manager.ensureTable("hot-updater-metadata"),
    ).rejects.toMatchObject({
      name: "DynamoDBAnalyticsSchemaError",
      componentVersion: "4",
    });
    expect(mocks.putItem).not.toHaveBeenCalled();
  });
});
