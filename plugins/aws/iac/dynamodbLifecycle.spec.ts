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

import { DYNAMODB_UPDATE_INDEX_NAME } from "../src/dynamodbDatabase";
import { DynamoDBManager } from "./dynamodb";

const compatibleTable = {
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" },
    { AttributeName: "sk", AttributeType: "S" },
    { AttributeName: "gsi1pk", AttributeType: "S" },
    { AttributeName: "gsi1sk", AttributeType: "S" },
  ],
  BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
  GlobalSecondaryIndexes: [
    {
      IndexName: DYNAMODB_UPDATE_INDEX_NAME,
      KeySchema: [
        { AttributeName: "gsi1pk", KeyType: "HASH" },
        { AttributeName: "gsi1sk", KeyType: "RANGE" },
      ],
      OnDemandThroughput: {
        MaxReadRequestUnits: 4_000,
        MaxWriteRequestUnits: 100,
      },
      Projection: { ProjectionType: "ALL" },
    },
  ],
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" },
    { AttributeName: "sk", KeyType: "RANGE" },
  ],
  OnDemandThroughput: {
    MaxReadRequestUnits: 4_000,
    MaxWriteRequestUnits: 100,
  },
} as const;

const manager = () =>
  new DynamoDBManager("ap-northeast-2", {
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  });

describe("DynamoDB lifecycle reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.describeTable.mockResolvedValue({ Table: compatibleTable });
    mocks.describeContinuousBackups.mockResolvedValue({
      ContinuousBackupsDescription: {
        PointInTimeRecoveryDescription: {
          PointInTimeRecoveryStatus: "ENABLED",
        },
      },
    });
    mocks.updateContinuousBackups.mockResolvedValue({});
  });

  it("does not rewrite enabled point-in-time recovery", async () => {
    await manager().ensureTable("hot-updater-metadata");

    expect(mocks.updateContinuousBackups).not.toHaveBeenCalled();
  });

  it("retries PITR reconciliation after table creation succeeds", async () => {
    mocks.describeTable
      .mockRejectedValueOnce({ name: "ResourceNotFoundException" })
      .mockResolvedValue({ Table: compatibleTable });
    mocks.createTable.mockResolvedValue({});
    mocks.waitUntilTableExists.mockResolvedValue({ state: "SUCCESS" });
    mocks.describeContinuousBackups.mockResolvedValue({
      ContinuousBackupsDescription: {
        PointInTimeRecoveryDescription: {
          PointInTimeRecoveryStatus: "DISABLED",
        },
      },
    });
    mocks.updateContinuousBackups
      .mockRejectedValueOnce(new Error("transient PITR failure"))
      .mockResolvedValue({});

    await expect(manager().ensureTable("hot-updater-metadata")).rejects.toThrow(
      "transient PITR failure",
    );
    await expect(
      manager().ensureTable("hot-updater-metadata"),
    ).resolves.toBeUndefined();

    expect(mocks.createTable).toHaveBeenCalledTimes(1);
    expect(mocks.updateContinuousBackups).toHaveBeenCalledTimes(2);
  });
});
