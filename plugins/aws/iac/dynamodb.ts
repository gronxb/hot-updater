import {
  type AttributeDefinition,
  type BatchWriteItemInput,
  type CreateTableInput,
  type UpdateContinuousBackupsInput,
  type UpdateTimeToLiveInput,
  DynamoDB,
  type KeySchemaElement,
  type TableDescription,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { InitError } from "@hot-updater/cli-tools";
import {
  encodeKvKey,
  SETTINGS_TABLE,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import { apiKeys, insights, remoteConfig } from "@hot-updater/server/plugins";

import { DYNAMODB_TTL_ATTRIBUTE } from "../src/dynamoDBStore";

const DYNAMODB_DESCRIBE_TABLE_ACTION = "dynamodb:DescribeTable";

export class DynamoDBTableSchemaError extends Error {
  readonly name = "DynamoDBTableSchemaError";

  constructor(readonly tableName: string) {
    super(
      `DynamoDB table "${tableName}" does not match the Hot Updater schema: a pk and sk key and no secondary index. A table from before 1.0 keeps its update index; delete it and rerun init to create it again.`,
    );
  }
}

/** TTL is on for another attribute; a table has one, and the store writes `_ttl`. */
export class DynamoDBTimeToLiveError extends Error {
  readonly name = "DynamoDBTimeToLiveError";

  constructor(
    readonly tableName: string,
    readonly attributeName: string | undefined,
  ) {
    super(
      `DynamoDB table "${tableName}" has TTL on "${attributeName}", but Hot Updater expires rows by "${DYNAMODB_TTL_ATTRIBUTE}". Turn TTL off on the table (aws dynamodb update-time-to-live --table-name ${tableName} --time-to-live-specification Enabled=false,AttributeName=${attributeName}), then rerun init.`,
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

const keyAttributes = ["pk", "sk"] as const;
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
    // The storage engine keeps its indexes as items; a secondary index marks a table from before 1.0.
    (table?.GlobalSecondaryIndexes ?? []).length === 0
  );
};

const isResourceNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "name") === "ResourceNotFoundException";

export const buildDynamoDBCreateTableInput = (tableName: string) =>
  ({
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
    DeletionProtectionEnabled: true,
    KeySchema: [...primaryKeySchema],
    OnDemandThroughput: onDemandThroughput,
    TableName: tableName,
  }) satisfies CreateTableInput;

/**
 * The schema settings items of core and the managed server's plugins, which
 * the database checks before its first read, as one BatchWriteItem request:
 * what `migrateDynamoDB` writes to a new table for those plugins.
 */
export const buildDynamoDBSchemaSettingsInput = (tableName: string) =>
  ({
    RequestItems: {
      [tableName]: Object.entries(
        toolingTargetOf([insights(), apiKeys(), remoteConfig()]).settings,
      ).map(([key, value]) => ({
        PutRequest: {
          Item: {
            pk: { S: SETTINGS_TABLE.name },
            sk: { S: encodeKvKey([key]) },
            key: { S: key },
            value: { S: value },
            _v: { N: "0" },
          },
        },
      })),
    },
  }) satisfies BatchWriteItemInput;

export const buildDynamoDBBackupInput = (tableName: string) =>
  ({
    PointInTimeRecoverySpecification: {
      PointInTimeRecoveryEnabled: true,
    },
    TableName: tableName,
  }) satisfies UpdateContinuousBackupsInput;

/**
 * Turns on the table's TTL, which deletes expired items for free: the store
 * writes `_ttl`, in epoch seconds, on every item of a row with retention.
 */
export const buildDynamoDBTimeToLiveInput = (tableName: string) =>
  ({
    TableName: tableName,
    TimeToLiveSpecification: {
      AttributeName: DYNAMODB_TTL_ATTRIBUTE,
      Enabled: true,
    },
  }) satisfies UpdateTimeToLiveInput;

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
      if (!hasExpectedSchema(Table)) {
        throw new DynamoDBTableSchemaError(tableName);
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

    await this.client.createTable(buildDynamoDBCreateTableInput(tableName));
    await waitUntilTableExists(
      { client: this.client, maxWaitTime: 120 },
      { TableName: tableName },
    );
    await this.ensureLifecycle(tableName);
  }

  /** Point-in-time recovery and TTL, each turned on only when it is off. */
  private async ensureLifecycle(tableName: string): Promise<void> {
    const { ContinuousBackupsDescription } =
      await this.client.describeContinuousBackups({ TableName: tableName });
    if (
      ContinuousBackupsDescription?.PointInTimeRecoveryDescription
        ?.PointInTimeRecoveryStatus !== "ENABLED"
    ) {
      await this.client.updateContinuousBackups(
        buildDynamoDBBackupInput(tableName),
      );
    }
    // UpdateTimeToLive refuses a repeat, so an enabled TTL is left as it is.
    const { TimeToLiveDescription: ttl } = await this.client.describeTimeToLive(
      { TableName: tableName },
    );
    const status = ttl?.TimeToLiveStatus;
    if (status === "ENABLED" || status === "ENABLING") {
      if (ttl?.AttributeName !== DYNAMODB_TTL_ATTRIBUTE) {
        throw new DynamoDBTimeToLiveError(tableName, ttl?.AttributeName);
      }
      return;
    }
    await this.client.updateTimeToLive(buildDynamoDBTimeToLiveInput(tableName));
  }
}
