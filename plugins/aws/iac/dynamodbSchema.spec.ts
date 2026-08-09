import type { ScalarAttributeType } from "@aws-sdk/client-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  describeTable: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@aws-sdk/client-dynamodb")>();
  return {
    ...original,
    DynamoDB: vi.fn(function DynamoDB() {
      return { describeTable: mocks.describeTable };
    }),
  };
});

import { DYNAMODB_UPDATE_INDEX_NAME } from "../src/dynamodbDatabase";
import { DynamoDBManager } from "./dynamodb";

const requiredAttributes = ["pk", "sk", "gsi1pk", "gsi1sk"] as const;

const tableWithAttributes = (
  attributes: readonly {
    readonly AttributeName: string;
    readonly AttributeType: ScalarAttributeType;
  }[],
) => ({
  AttributeDefinitions: attributes,
  BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
  OnDemandThroughput: {
    MaxReadRequestUnits: 4_000,
    MaxWriteRequestUnits: 100,
  },
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
});

describe("DynamoDB existing table key types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(
    requiredAttributes.flatMap((attributeName) =>
      (["N", "B"] as const).map((attributeType) => ({
        attributeName,
        attributeType,
      })),
    ),
  )("rejects $attributeType for $attributeName", async (invalid) => {
    // Given
    mocks.describeTable.mockResolvedValue({
      Table: tableWithAttributes(
        requiredAttributes.map((attributeName) => ({
          AttributeName: attributeName,
          AttributeType:
            attributeName === invalid.attributeName
              ? invalid.attributeType
              : "S",
        })),
      ),
    });
    const manager = new DynamoDBManager("us-east-1", {
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

  it.each(requiredAttributes)(
    "rejects a missing %s definition",
    async (missing) => {
      // Given
      mocks.describeTable.mockResolvedValue({
        Table: tableWithAttributes(
          requiredAttributes
            .filter((attributeName) => attributeName !== missing)
            .map((attributeName) => ({
              AttributeName: attributeName,
              AttributeType: "S",
            })),
        ),
      });
      const manager = new DynamoDBManager("us-east-1", {
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
    },
  );
});
