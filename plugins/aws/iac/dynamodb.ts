import { createHash } from "node:crypto";

import {
  type AttributeDefinition,
  DynamoDB,
  type KeySchemaElement,
  type TableDescription,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { InitError } from "@hot-updater/cli-tools";

import { DYNAMODB_UPDATE_INDEX_NAME } from "../src/dynamoDB";

const DYNAMODB_DESCRIBE_TABLE_ACTION = "dynamodb:DescribeTable";

export class DynamoDBTableSchemaError extends Error {
  readonly name = "DynamoDBTableSchemaError";

  constructor(readonly tableName: string) {
    super(
      `DynamoDB table "${tableName}" does not match the Hot Updater key and index schema`,
    );
  }
}

export class DynamoDBPermissionError extends InitError {
  readonly name = "DynamoDBPermissionError";
  readonly requiredAction = DYNAMODB_DESCRIBE_TABLE_ACTION;

  constructor(
    readonly tableName: string,
    readonly region: string,
    cause: Error,
  ) {
    super(
      [
        `AWS credentials cannot access DynamoDB table "${tableName}" in ${region}.`,
        `Required permission: ${DYNAMODB_DESCRIBE_TABLE_ACTION}`,
        `AWS error: ${cause.message}`,
        "Ask your AWS administrator to grant this permission, or attach the AmazonDynamoDBFullAccess_v2 managed policy, to the identity used for init.",
        "For AWS IAM Identity Center, update the assigned permission set and refresh the SSO session.",
        "Then rerun `hot-updater init`.",
      ].join("\n"),
      { cause },
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

const keyAttributes = ["pk", "sk", "gsi1pk", "gsi1sk"] as const;
const onDemandThroughput = {
  MaxReadRequestUnits: 4_000,
  MaxWriteRequestUnits: 100,
} as const;

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
    keyAttributes.every((attributeName) =>
      table?.AttributeDefinitions?.some(
        ({ AttributeName, AttributeType }: AttributeDefinition) =>
          AttributeName === attributeName && AttributeType === "S",
      ),
    ) &&
    table?.BillingModeSummary?.BillingMode === "PAY_PER_REQUEST" &&
    table.OnDemandThroughput?.MaxReadRequestUnits ===
      onDemandThroughput.MaxReadRequestUnits &&
    table.OnDemandThroughput?.MaxWriteRequestUnits ===
      onDemandThroughput.MaxWriteRequestUnits &&
    hasKeySchema(table?.KeySchema, primaryKeySchema) &&
    hasKeySchema(updateIndex?.KeySchema, updateIndexKeySchema) &&
    updateIndex?.OnDemandThroughput?.MaxReadRequestUnits ===
      onDemandThroughput.MaxReadRequestUnits &&
    updateIndex?.OnDemandThroughput?.MaxWriteRequestUnits ===
      onDemandThroughput.MaxWriteRequestUnits &&
    updateIndex?.Projection?.ProjectionType === "ALL"
  );
};

const isResourceNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "name") === "ResourceNotFoundException";

const getAuthorityId = (
  tableName: string,
  table: TableDescription | undefined,
): string => {
  const tableArn = table?.TableArn;
  if (!tableArn) {
    throw new DynamoDBTableSchemaError(tableName);
  }
  return `aws.${createHash("sha256").update(tableArn).digest("base64url")}`;
};

export class DynamoDBManager {
  private readonly client: DynamoDB;

  constructor(
    private readonly region: string,
    credentials: {
      readonly accessKeyId: string;
      readonly secretAccessKey: string;
    },
  ) {
    this.client = new DynamoDB({ credentials, region });
  }

  async ensureTable(tableName: string): Promise<string> {
    try {
      const { Table } = await this.client.describeTable({
        TableName: tableName,
      });
      if (!hasExpectedSchema(Table)) {
        throw new DynamoDBTableSchemaError(tableName);
      }
      await this.ensureLifecycle(tableName);
      return getAuthorityId(tableName, Table);
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "AccessDeniedException" &&
        error.message.includes(DYNAMODB_DESCRIBE_TABLE_ACTION)
      ) {
        throw new DynamoDBPermissionError(tableName, this.region, error);
      }
      if (!isResourceNotFound(error)) throw error;
    }

    const created = await this.client.createTable({
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "gsi1pk", AttributeType: "S" },
        { AttributeName: "gsi1sk", AttributeType: "S" },
      ],
      BillingMode: "PAY_PER_REQUEST",
      DeletionProtectionEnabled: true,
      GlobalSecondaryIndexes: [
        {
          IndexName: DYNAMODB_UPDATE_INDEX_NAME,
          KeySchema: [...updateIndexKeySchema],
          Projection: { ProjectionType: "ALL" },
          OnDemandThroughput: onDemandThroughput,
        },
      ],
      KeySchema: [...primaryKeySchema],
      OnDemandThroughput: onDemandThroughput,
      TableName: tableName,
    });
    await waitUntilTableExists(
      { client: this.client, maxWaitTime: 120 },
      { TableName: tableName },
    );
    await this.ensureLifecycle(tableName);
    const table =
      created.TableDescription ??
      (await this.client.describeTable({ TableName: tableName })).Table;
    return getAuthorityId(tableName, table);
  }

  private async ensureLifecycle(tableName: string): Promise<void> {
    const { ContinuousBackupsDescription } =
      await this.client.describeContinuousBackups({ TableName: tableName });
    if (
      ContinuousBackupsDescription?.PointInTimeRecoveryDescription
        ?.PointInTimeRecoveryStatus === "ENABLED"
    ) {
      return;
    }
    await this.client.updateContinuousBackups({
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      TableName: tableName,
    });
  }
}
