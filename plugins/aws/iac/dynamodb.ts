import {
  DynamoDB,
  type KeySchemaElement,
  type TableDescription,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";

import { DYNAMODB_UPDATE_INDEX_NAME } from "../src/dynamodbDatabase";

export class DynamoDBTableSchemaError extends Error {
  readonly name = "DynamoDBTableSchemaError";

  constructor(readonly tableName: string) {
    super(
      `DynamoDB table "${tableName}" does not match the Hot Updater key and index schema`,
    );
  }
}

const primaryKeySchema = [
  { AttributeName: "pk", KeyType: "HASH" },
  { AttributeName: "sk", KeyType: "RANGE" },
] as const satisfies readonly KeySchemaElement[];

const updateIndexKeySchema = [
  { AttributeName: "gsi1pk", KeyType: "HASH" },
  { AttributeName: "gsi1sk", KeyType: "RANGE" },
] as const satisfies readonly KeySchemaElement[];

const hasKeySchema = (
  actual: readonly KeySchemaElement[] | undefined,
  expected: readonly KeySchemaElement[],
): boolean =>
  actual?.length === expected.length &&
  expected.every(({ AttributeName, KeyType }) =>
    actual.some(
      (key) => key.AttributeName === AttributeName && key.KeyType === KeyType,
    ),
  );

const hasExpectedSchema = (table: TableDescription | undefined): boolean => {
  const updateIndex = table?.GlobalSecondaryIndexes?.find(
    ({ IndexName }) => IndexName === DYNAMODB_UPDATE_INDEX_NAME,
  );
  return (
    hasKeySchema(table?.KeySchema, primaryKeySchema) &&
    hasKeySchema(updateIndex?.KeySchema, updateIndexKeySchema) &&
    updateIndex?.Projection?.ProjectionType === "ALL"
  );
};

const isResourceNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "name") === "ResourceNotFoundException";

export class DynamoDBManager {
  private readonly client: DynamoDB;

  constructor(
    region: string,
    credentials: {
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
    },
  ) {
    this.client = new DynamoDB({ credentials, region });
  }

  async ensureTable(tableName: string): Promise<void> {
    try {
      const { Table } = await this.client.describeTable({
        TableName: tableName,
      });
      if (!hasExpectedSchema(Table)) {
        throw new DynamoDBTableSchemaError(tableName);
      }
      return;
    } catch (error) {
      if (!isResourceNotFound(error)) throw error;
    }

    await this.client.createTable({
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "gsi1pk", AttributeType: "S" },
        { AttributeName: "gsi1sk", AttributeType: "S" },
      ],
      BillingMode: "PAY_PER_REQUEST",
      GlobalSecondaryIndexes: [
        {
          IndexName: DYNAMODB_UPDATE_INDEX_NAME,
          KeySchema: [...updateIndexKeySchema],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      KeySchema: [...primaryKeySchema],
      TableName: tableName,
    });
    await waitUntilTableExists(
      { client: this.client, maxWaitTime: 120 },
      { TableName: tableName },
    );
  }
}
