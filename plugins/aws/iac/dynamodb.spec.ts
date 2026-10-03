import { InitError } from "@hot-updater/cli-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTable: vi.fn(),
  describeContinuousBackups: vi.fn(),
  describeTable: vi.fn(),
  describeTimeToLive: vi.fn(),
  updateContinuousBackups: vi.fn(),
  updateTimeToLive: vi.fn(),
  waitUntilTableExists: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDB: vi.fn(function DynamoDB() {
    return {
      createTable: mocks.createTable,
      describeContinuousBackups: mocks.describeContinuousBackups,
      describeTable: mocks.describeTable,
      describeTimeToLive: mocks.describeTimeToLive,
      updateContinuousBackups: mocks.updateContinuousBackups,
      updateTimeToLive: mocks.updateTimeToLive,
    };
  }),
  waitUntilTableExists: mocks.waitUntilTableExists,
}));

import { DynamoDBManager } from "./dynamodb";

const compatibleTable = {
  TableArn:
    "arn:aws:dynamodb:ap-northeast-2:123456789012:table/hot-updater-metadata",
  BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
  OnDemandThroughput: {
    MaxReadRequestUnits: 4_000,
    MaxWriteRequestUnits: 100,
  },
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" },
    { AttributeName: "sk", AttributeType: "S" },
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
    mocks.describeTimeToLive.mockResolvedValue({
      TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" },
    });
    mocks.updateTimeToLive.mockResolvedValue({});
  });

  it("creates an on-demand metadata table with no secondary index", async () => {
    // Given
    mocks.describeTable.mockRejectedValue({
      name: "ResourceNotFoundException",
    });
    mocks.createTable.mockResolvedValue({
      TableDescription: compatibleTable,
    });
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
      }),
    );
    expect(mocks.createTable.mock.calls[0]?.[0]).not.toHaveProperty(
      "GlobalSecondaryIndexes",
    );
    expect(mocks.updateContinuousBackups).toHaveBeenCalledWith({
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      TableName: "hot-updater-metadata",
    });
    expect(mocks.updateTimeToLive).toHaveBeenCalledWith({
      TableName: "hot-updater-metadata",
      TimeToLiveSpecification: { AttributeName: "_ttl", Enabled: true },
    });
  });

  it("turns on TTL for an existing table once, and refuses TTL on another attribute", async () => {
    mocks.describeTable.mockResolvedValue({ Table: compatibleTable });
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    await manager.ensureTable("hot-updater-metadata");
    expect(mocks.updateTimeToLive).toHaveBeenCalledTimes(1);

    mocks.describeTimeToLive.mockResolvedValue({
      TimeToLiveDescription: {
        AttributeName: "_ttl",
        TimeToLiveStatus: "ENABLED",
      },
    });
    await manager.ensureTable("hot-updater-metadata");
    expect(mocks.updateTimeToLive).toHaveBeenCalledTimes(1);

    mocks.describeTimeToLive.mockResolvedValue({
      TimeToLiveDescription: {
        AttributeName: "expires",
        TimeToLiveStatus: "ENABLED",
      },
    });
    await expect(manager.ensureTable("hot-updater-metadata")).rejects.toThrow(
      'has TTL on "expires", but Hot Updater expires rows by "_ttl"',
    );
  });

  it("reuses a table with the managed key schema", async () => {
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
            definition.AttributeName === "sk"
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
});
