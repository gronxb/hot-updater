import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTable: vi.fn(),
  describeTable: vi.fn(),
  waitUntilTableExists: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDB: vi.fn(function DynamoDB() {
    return {
      createTable: mocks.createTable,
      describeTable: mocks.describeTable,
    };
  }),
  waitUntilTableExists: mocks.waitUntilTableExists,
}));

import { DYNAMODB_UPDATE_INDEX_NAME } from "../src/dynamodbDatabase";
import { DynamoDBManager } from "./dynamodb";

describe("DynamoDBManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        TableName: "hot-updater-metadata",
        GlobalSecondaryIndexes: [
          expect.objectContaining({ IndexName: DYNAMODB_UPDATE_INDEX_NAME }),
        ],
      }),
    );
  });

  it("reuses a table with the managed key and index schema", async () => {
    // Given
    mocks.describeTable.mockResolvedValue({
      Table: {
        GlobalSecondaryIndexes: [
          {
            IndexName: DYNAMODB_UPDATE_INDEX_NAME,
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      },
    });
    const manager = new DynamoDBManager("ap-northeast-2", {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    });

    // When
    await manager.ensureTable("hot-updater-metadata");

    // Then
    expect(mocks.createTable).not.toHaveBeenCalled();
  });

  it("rejects an existing table with an incompatible schema", async () => {
    // Given
    mocks.describeTable.mockResolvedValue({
      Table: {
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
});
