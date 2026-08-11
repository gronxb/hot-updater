import { InitError } from "@hot-updater/cli-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTable: vi.fn(),
  describeContinuousBackups: vi.fn(),
  describeTable: vi.fn(),
  updateContinuousBackups: vi.fn(),
  waitUntilTableExists: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDB: vi.fn(function DynamoDB() {
    return {
      createTable: mocks.createTable,
      describeContinuousBackups: mocks.describeContinuousBackups,
      describeTable: mocks.describeTable,
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
});
