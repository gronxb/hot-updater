import { randomUUID } from "node:crypto";

import {
  type AttributeValue,
  type AttributeDefinition,
  DynamoDB,
  type KeySchemaElement,
  type TableDescription,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { InitError } from "@hot-updater/cli-tools";

import {
  DYNAMODB_CHANNEL_NAME_PARTITION,
  DYNAMODB_CHANNEL_PARTITION,
  DYNAMODB_UPDATE_INDEX_NAME,
} from "../src/dynamoDB";

const DYNAMODB_DESCRIBE_TABLE_ACTION = "dynamodb:DescribeTable";
const DYNAMODB_BUNDLE_PARTITION = "bundles";

type DynamoDBChannel = {
  readonly id: string;
  readonly name: string;
  readonly referenceCount?: number;
  readonly version: number;
};

type DynamoDBBundleChannel = {
  readonly id: string;
  readonly channel: string;
  readonly channelId?: string;
};

export class DynamoDBChannelMigrationError extends Error {
  readonly name = "DynamoDBChannelMigrationError";

  constructor(message: string) {
    super(message);
  }
}

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
      await this.ensureChannels(tableName);
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
    await this.ensureChannels(tableName);
  }

  private async queryPartition(
    tableName: string,
    partition: string,
  ): Promise<readonly Record<string, AttributeValue>[]> {
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    const items: Record<string, AttributeValue>[] = [];
    do {
      const page = await this.client.query({
        TableName: tableName,
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": { S: partition } },
      });
      items.push(...(page.Items ?? []));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  private parseChannel(item: Record<string, AttributeValue>): DynamoDBChannel {
    const id = item.row?.M?.id?.S;
    const name = item.row?.M?.name?.S;
    const referenceCountValue = item.reference_count?.N;
    const referenceCount =
      referenceCountValue === undefined
        ? undefined
        : Number(referenceCountValue);
    const version = Number(item.version?.N);
    if (
      item.pk?.S !== DYNAMODB_CHANNEL_PARTITION ||
      item.sk?.S !== id ||
      id === undefined ||
      name === undefined ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      (referenceCount !== undefined &&
        (!Number.isSafeInteger(referenceCount) || referenceCount < 0)) ||
      !this.isChannelText(id) ||
      !this.isChannelText(name)
    ) {
      throw new DynamoDBChannelMigrationError(
        "DynamoDB contains an invalid Hot Updater channel row",
      );
    }
    return { id, name, referenceCount, version };
  }

  private parseBundleChannel(
    item: Record<string, AttributeValue>,
  ): DynamoDBBundleChannel {
    const id = item.row?.M?.id?.S;
    const channel = item.row?.M?.channel?.S;
    const channelId = item.row?.M?.channel_id?.S;
    if (
      item.pk?.S !== DYNAMODB_BUNDLE_PARTITION ||
      item.sk?.S !== id ||
      id === undefined ||
      channel === undefined ||
      !this.isChannelText(channel) ||
      (channelId !== undefined && !this.isChannelText(channelId))
    ) {
      throw new DynamoDBChannelMigrationError(
        "DynamoDB contains an invalid Hot Updater bundle channel",
      );
    }
    return { id, channel, ...(channelId ? { channelId } : {}) };
  }

  private isChannelText(value: string): boolean {
    const length = Array.from(value).length;
    return length >= 1 && length <= 255;
  }

  private async getChannelClaim(
    tableName: string,
    name: string,
  ): Promise<string | undefined> {
    const { Item } = await this.client.getItem({
      TableName: tableName,
      ConsistentRead: true,
      Key: {
        pk: { S: DYNAMODB_CHANNEL_NAME_PARTITION },
        sk: { S: name },
      },
    });
    if (Item === undefined) return undefined;
    const channelId = Item.channel_id?.S;
    if (channelId === undefined || !this.isChannelText(channelId)) {
      throw new DynamoDBChannelMigrationError(
        `DynamoDB contains an invalid channel-name claim for "${name}"`,
      );
    }
    return channelId;
  }

  private async readChannel(
    tableName: string,
    id: string,
  ): Promise<DynamoDBChannel | undefined> {
    const { Item } = await this.client.getItem({
      TableName: tableName,
      ConsistentRead: true,
      Key: {
        pk: { S: DYNAMODB_CHANNEL_PARTITION },
        sk: { S: id },
      },
    });
    return Item === undefined ? undefined : this.parseChannel(Item);
  }

  private async readClaimedChannel(
    tableName: string,
    name: string,
  ): Promise<DynamoDBChannel | undefined> {
    const id = await this.getChannelClaim(tableName, name);
    if (id === undefined) return undefined;
    const channel = await this.readChannel(tableName, id);
    if (channel?.name !== name) {
      throw new DynamoDBChannelMigrationError(
        `DynamoDB channel-name claim for "${name}" has no matching channel row`,
      );
    }
    return channel;
  }

  private async claimExistingChannel(
    tableName: string,
    channel: DynamoDBChannel,
  ): Promise<DynamoDBChannel> {
    try {
      await this.client.putItem({
        TableName: tableName,
        Item: {
          pk: { S: DYNAMODB_CHANNEL_NAME_PARTITION },
          sk: { S: channel.name },
          channel_id: { S: channel.id },
        },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" },
      });
      return channel;
    } catch (error) {
      if (!this.isConditionalConflict(error)) throw error;
      const claimed = await this.readClaimedChannel(tableName, channel.name);
      if (claimed === undefined) throw error;
      return claimed;
    }
  }

  private async createClaimedChannel(
    tableName: string,
    name: string,
  ): Promise<DynamoDBChannel> {
    const channel = { id: randomUUID(), name, referenceCount: 0, version: 1 };
    try {
      await this.client.transactWriteItems({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: { S: DYNAMODB_CHANNEL_NAME_PARTITION },
                sk: { S: name },
                channel_id: { S: channel.id },
              },
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: { S: DYNAMODB_CHANNEL_PARTITION },
                sk: { S: channel.id },
                version: { N: "1" },
                reference_count: { N: "0" },
                row: {
                  M: { id: { S: channel.id }, name: { S: channel.name } },
                },
              },
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "pk" },
            },
          },
        ],
      });
      return channel;
    } catch (error) {
      if (!this.isConditionalConflict(error)) throw error;
      const claimed = await this.readClaimedChannel(tableName, name);
      if (claimed === undefined) throw error;
      return claimed;
    }
  }

  private isConditionalConflict(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const name = Reflect.get(error, "name");
    return (
      name === "ConditionalCheckFailedException" ||
      name === "TransactionCanceledException"
    );
  }

  private async setBundleChannelId(
    tableName: string,
    bundle: DynamoDBBundleChannel,
    channelId: string,
  ): Promise<void> {
    try {
      await this.client.updateItem({
        TableName: tableName,
        Key: {
          pk: { S: DYNAMODB_BUNDLE_PARTITION },
          sk: { S: bundle.id },
        },
        ConditionExpression:
          "attribute_not_exists(#row.#channelId) AND #row.#channel = :channel",
        UpdateExpression:
          "SET #row.#channelId = :channelId, #version = #version + :one",
        ExpressionAttributeNames: {
          "#channel": "channel",
          "#channelId": "channel_id",
          "#row": "row",
          "#version": "version",
        },
        ExpressionAttributeValues: {
          ":channel": { S: bundle.channel },
          ":channelId": { S: channelId },
          ":one": { N: "1" },
        },
      });
    } catch (error) {
      if (!this.isConditionalConflict(error)) throw error;
      const { Item } = await this.client.getItem({
        TableName: tableName,
        ConsistentRead: true,
        Key: {
          pk: { S: DYNAMODB_BUNDLE_PARTITION },
          sk: { S: bundle.id },
        },
      });
      if (
        Item !== undefined &&
        this.parseBundleChannel(Item).channelId === channelId
      ) {
        return;
      }
      throw error;
    }
  }

  private async setChannelReferenceCount(
    tableName: string,
    channel: DynamoDBChannel,
    referenceCount: number,
  ): Promise<void> {
    if (channel.referenceCount === referenceCount) return;
    try {
      await this.client.updateItem({
        TableName: tableName,
        Key: {
          pk: { S: DYNAMODB_CHANNEL_PARTITION },
          sk: { S: channel.id },
        },
        ConditionExpression: "#version = :version AND #row.#name = :name",
        UpdateExpression:
          "SET #referenceCount = :referenceCount, #version = #version + :one",
        ExpressionAttributeNames: {
          "#name": "name",
          "#referenceCount": "reference_count",
          "#row": "row",
          "#version": "version",
        },
        ExpressionAttributeValues: {
          ":name": { S: channel.name },
          ":one": { N: "1" },
          ":referenceCount": { N: String(referenceCount) },
          ":version": { N: String(channel.version) },
        },
      });
    } catch (error) {
      if (!this.isConditionalConflict(error)) throw error;
      const latest = await this.readChannel(tableName, channel.id);
      if (
        latest?.name === channel.name &&
        latest.referenceCount === referenceCount
      ) {
        return;
      }
      throw error;
    }
  }

  private async ensureChannels(tableName: string): Promise<void> {
    const storedChannels = (
      await this.queryPartition(tableName, DYNAMODB_CHANNEL_PARTITION)
    ).map((item) => this.parseChannel(item));
    const channelsByName = new Map<string, DynamoDBChannel>();
    for (const channel of storedChannels) {
      const duplicate = channelsByName.get(channel.name);
      if (duplicate !== undefined && duplicate.id !== channel.id) {
        throw new DynamoDBChannelMigrationError(
          `DynamoDB contains duplicate channel rows named "${channel.name}"`,
        );
      }
      channelsByName.set(channel.name, channel);
    }

    const claimedChannelsByName = new Map<string, DynamoDBChannel>();
    for (const channel of storedChannels) {
      const claimed = await this.readClaimedChannel(tableName, channel.name);
      const canonical =
        claimed ?? (await this.claimExistingChannel(tableName, channel));
      if (canonical.id !== channel.id) {
        throw new DynamoDBChannelMigrationError(
          `DynamoDB channel-name claim for "${channel.name}" conflicts with its channel row`,
        );
      }
      claimedChannelsByName.set(channel.name, canonical);
    }

    const bundles = (
      await this.queryPartition(tableName, DYNAMODB_BUNDLE_PARTITION)
    ).map((item) => this.parseBundleChannel(item));
    for (const name of new Set(bundles.map(({ channel }) => channel))) {
      const existing = channelsByName.get(name);
      const channel =
        claimedChannelsByName.get(name) ??
        (existing
          ? await this.claimExistingChannel(tableName, existing)
          : await this.createClaimedChannel(tableName, name));
      if (existing !== undefined && existing.id !== channel.id) {
        throw new DynamoDBChannelMigrationError(
          `DynamoDB channel-name claim for "${name}" conflicts with its channel row`,
        );
      }
      channelsByName.set(name, channel);
      claimedChannelsByName.set(name, channel);
    }

    for (const bundle of bundles) {
      const channel = channelsByName.get(bundle.channel);
      if (channel === undefined) {
        throw new DynamoDBChannelMigrationError(
          `DynamoDB bundle "${bundle.id}" has no channel row`,
        );
      }
      if (bundle.channelId !== undefined) {
        if (bundle.channelId !== channel.id) {
          throw new DynamoDBChannelMigrationError(
            `DynamoDB bundle "${bundle.id}" has a mismatched channel_id`,
          );
        }
        continue;
      }
      await this.setBundleChannelId(tableName, bundle, channel.id);
    }
    const referenceCounts = new Map<string, number>();
    for (const bundle of bundles) {
      const channel = channelsByName.get(bundle.channel);
      if (channel === undefined) continue;
      referenceCounts.set(
        channel.id,
        (referenceCounts.get(channel.id) ?? 0) + 1,
      );
    }
    for (const channel of channelsByName.values()) {
      await this.setChannelReferenceCount(
        tableName,
        channel,
        referenceCounts.get(channel.id) ?? 0,
      );
    }
  }

  private async ensureLifecycle(tableName: string): Promise<void> {
    await this.ensurePointInTimeRecovery(tableName);
  }

  private async ensurePointInTimeRecovery(tableName: string): Promise<void> {
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
