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

const hasNoOnDemandCap = (
  throughput: TableDescription["OnDemandThroughput"],
): boolean =>
  (throughput?.MaxReadRequestUnits === undefined ||
    throughput.MaxReadRequestUnits === -1) &&
  (throughput?.MaxWriteRequestUnits === undefined ||
    throughput.MaxWriteRequestUnits === -1);

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
    table?.AttributeDefinitions?.length === keyAttributes.length &&
    keyAttributes.every((attributeName) =>
      table?.AttributeDefinitions?.some(
        ({ AttributeName, AttributeType }: AttributeDefinition) =>
          AttributeName === attributeName && AttributeType === "S",
      ),
    ) &&
    table?.BillingModeSummary?.BillingMode === "PAY_PER_REQUEST" &&
    hasKeySchema(table?.KeySchema, primaryKeySchema) &&
    table?.GlobalSecondaryIndexes?.length === 1 &&
    hasKeySchema(updateIndex?.KeySchema, updateIndexKeySchema) &&
    updateIndex?.Projection?.ProjectionType === "ALL"
  );
};

const isActiveAndUnlimited = (table: TableDescription | undefined): boolean => {
  const updateIndex = table?.GlobalSecondaryIndexes?.find(
    ({ IndexName }) => IndexName === DYNAMODB_UPDATE_INDEX_NAME,
  );
  return (
    table?.TableStatus === "ACTIVE" &&
    updateIndex?.IndexStatus === "ACTIVE" &&
    hasNoOnDemandCap(table.OnDemandThroughput) &&
    hasNoOnDemandCap(updateIndex.OnDemandThroughput)
  );
};

const isResourceNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "name") === "ResourceNotFoundException";

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

  async ensureTable(tableName: string): Promise<void> {
    try {
      const { Table } = await this.client.describeTable({
        TableName: tableName,
      });
      if (Table === undefined || !hasExpectedSchema(Table)) {
        throw new DynamoDBTableSchemaError(tableName);
      }
      let ready = Table;
      if (!isActiveAndUnlimited(ready)) {
        if (
          ready.TableStatus !== "ACTIVE" ||
          ready.GlobalSecondaryIndexes?.find(
            ({ IndexName }) => IndexName === DYNAMODB_UPDATE_INDEX_NAME,
          )?.IndexStatus !== "ACTIVE"
        ) {
          ready = await this.waitForActiveTable(tableName, false);
        }
        if (await this.ensureUnlimitedOnDemand(tableName, ready)) {
          ready = await this.waitForActiveTable(tableName, true);
        }
        if (!hasExpectedSchema(ready) || !isActiveAndUnlimited(ready)) {
          throw new DynamoDBTableSchemaError(tableName);
        }
      }
      await this.ensureLifecycle(tableName);
      return;
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

    await this.client.createTable({
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
        },
      ],
      KeySchema: [...primaryKeySchema],
      TableName: tableName,
    });
    const ready = await this.waitForActiveTable(tableName, true);
    if (!hasExpectedSchema(ready) || !isActiveAndUnlimited(ready)) {
      throw new DynamoDBTableSchemaError(tableName);
    }
    await this.ensureLifecycle(tableName);
  }

  private async waitForActiveTable(
    tableName: string,
    requireUnlimited: boolean,
  ): Promise<TableDescription> {
    await waitUntilTableExists(
      { client: this.client, maxWaitTime: 120 },
      { TableName: tableName },
    );
    for (let attempt = 0; attempt < 24; attempt++) {
      const { Table } = await this.client.describeTable({
        TableName: tableName,
      });
      if (Table === undefined || !hasExpectedSchema(Table)) {
        throw new DynamoDBTableSchemaError(tableName);
      }
      if (
        Table.TableStatus === "ACTIVE" &&
        Table.GlobalSecondaryIndexes?.[0]?.IndexStatus === "ACTIVE" &&
        (!requireUnlimited || isActiveAndUnlimited(Table))
      ) {
        return Table;
      }
      if (attempt < 23) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
    throw new DynamoDBTableSchemaError(tableName);
  }

  private async ensureUnlimitedOnDemand(
    tableName: string,
    table: TableDescription,
  ): Promise<boolean> {
    const updateIndex = table.GlobalSecondaryIndexes?.find(
      ({ IndexName }) => IndexName === DYNAMODB_UPDATE_INDEX_NAME,
    );
    const updateTable = !hasNoOnDemandCap(table.OnDemandThroughput);
    const updateIndexThroughput = !hasNoOnDemandCap(
      updateIndex?.OnDemandThroughput,
    );
    if (!updateTable && !updateIndexThroughput) return false;
    await this.client.updateTable({
      TableName: tableName,
      ...(updateTable
        ? {
            OnDemandThroughput: {
              MaxReadRequestUnits: -1,
              MaxWriteRequestUnits: -1,
            },
          }
        : {}),
      ...(updateIndexThroughput
        ? {
            GlobalSecondaryIndexUpdates: [
              {
                Update: {
                  IndexName: DYNAMODB_UPDATE_INDEX_NAME,
                  OnDemandThroughput: {
                    MaxReadRequestUnits: -1,
                    MaxWriteRequestUnits: -1,
                  },
                },
              },
            ],
          }
        : {}),
    });
    return true;
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
