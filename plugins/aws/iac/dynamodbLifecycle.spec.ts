import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTable: vi.fn(),
  describeContinuousBackups: vi.fn(),
  describeTable: vi.fn(),
  describeTimeToLive: vi.fn(),
  getItem: vi.fn(),
  putItem: vi.fn(),
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
      getItem: mocks.getItem,
      putItem: mocks.putItem,
      updateContinuousBackups: mocks.updateContinuousBackups,
      updateTimeToLive: mocks.updateTimeToLive,
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
    mocks.describeTimeToLive.mockResolvedValue({
      TimeToLiveDescription: {
        AttributeName: "expires_at_s",
        TimeToLiveStatus: "ENABLED",
      },
    });
    mocks.getItem.mockResolvedValue({ Item: { value: { S: "3" } } });
    mocks.updateContinuousBackups.mockResolvedValue({});
    mocks.updateTimeToLive.mockResolvedValue({});
  });

  it("does not rewrite enabled point-in-time recovery", async () => {
    await manager().ensureTable("hot-updater-metadata");

    expect(mocks.updateContinuousBackups).not.toHaveBeenCalled();
  });

  it("rejects an active TTL attribute owned by another application", async () => {
    mocks.describeContinuousBackups.mockResolvedValue({
      ContinuousBackupsDescription: {
        PointInTimeRecoveryDescription: {
          PointInTimeRecoveryStatus: "DISABLED",
        },
      },
    });
    mocks.describeTimeToLive.mockResolvedValue({
      TimeToLiveDescription: {
        AttributeName: "other_expiry",
        TimeToLiveStatus: "ENABLED",
      },
    });

    await expect(
      manager().ensureTable("hot-updater-metadata"),
    ).rejects.toMatchObject({
      name: "DynamoDBTimeToLiveSchemaError",
      attributeName: "other_expiry",
      status: "ENABLED",
    });
    expect(mocks.updateTimeToLive).not.toHaveBeenCalled();
    expect(mocks.updateContinuousBackups).not.toHaveBeenCalled();
  });

  it("waits for a managed TTL disable transition instead of racing it", async () => {
    mocks.describeTimeToLive.mockResolvedValue({
      TimeToLiveDescription: {
        AttributeName: "expires_at_s",
        TimeToLiveStatus: "DISABLING",
      },
    });

    await expect(
      manager().ensureTable("hot-updater-metadata"),
    ).rejects.toMatchObject({
      name: "DynamoDBTimeToLiveSchemaError",
      status: "DISABLING",
    });
    expect(mocks.updateTimeToLive).not.toHaveBeenCalled();
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
