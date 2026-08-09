import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AnalyticsSchemaNotReadyError,
  type BundleEventPersistenceRow,
} from "@hot-updater/analytics/provider";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DYNAMODB_ANALYTICS_RETENTION_SECONDS,
  DYNAMODB_ANALYTICS_SCHEMA_VERSION,
  analyticsEventPartition,
  createDynamoDBAnalyticsPersistence,
} from "./dynamodbAnalyticsPersistence";

const dynamodb = mockClient(DynamoDBDocumentClient);

const unchangedRow = (
  id: string,
  receivedAtMs: number,
): BundleEventPersistenceRow => ({
  id,
  type: "UNCHANGED",
  install_id: `install-${id}`,
  user_id: null,
  username: null,
  from_bundle_id: null,
  to_bundle_id: `bundle-${id}`,
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  update_strategy: null,
  fingerprint_hash: null,
  sdk_version: "1.2.3",
  received_at_ms: receivedAtMs,
});

const createPersistence = () => {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({} as DynamoDBClientConfig),
  );
  return createDynamoDBAnalyticsPersistence({
    client,
    tableName: "hot-updater-metadata",
  });
};

describe("DynamoDB Analytics persistence", () => {
  beforeEach(() => {
    dynamodb.reset();
    dynamodb.on(GetCommand).resolves({
      Item: { value: DYNAMODB_ANALYTICS_SCHEMA_VERSION },
    });
  });

  it("appends immutable events across deterministic time-bucket shards", async () => {
    const persistence = createPersistence();
    const receivedAtMs = Date.UTC(2026, 0, 15);
    const rows = Array.from({ length: 32 }, (_, index) =>
      unchangedRow(`event-${index}`, receivedAtMs),
    );
    dynamodb.on(PutCommand).resolves({});

    for (const row of rows) await persistence.append(row);

    const calls = dynamodb.commandCalls(PutCommand);
    const partitions = new Set(calls.map(({ args }) => args[0].input.Item?.pk));
    expect(partitions.size).toBeGreaterThan(1);
    expect(calls[0]?.args[0].input).toMatchObject({
      TableName: "hot-updater-metadata",
      ConditionExpression: "attribute_not_exists(#pk)",
      Item: {
        ...rows[0],
        pk: analyticsEventPartition(rows[0]?.id ?? "", receivedAtMs),
        sk: `${String(receivedAtMs).padStart(13, "0")}#event-0`,
        expires_at_s:
          Math.floor(receivedAtMs / 1_000) +
          DYNAMODB_ANALYTICS_RETENTION_SECONDS,
      },
    });
  });

  it("merges adjacent buckets and shards with an exclusive ordered cursor", async () => {
    const persistence = createPersistence();
    const rows = [
      unchangedRow("event-a", Date.UTC(2026, 0, 31, 23, 59)),
      unchangedRow("event-b", Date.UTC(2026, 1, 1)),
      unchangedRow("event-c", Date.UTC(2026, 1, 1)),
      unchangedRow("event-d", Date.UTC(2026, 1, 2)),
    ];
    dynamodb.on(QueryCommand).callsFake((input) => {
      const partition = input.ExpressionAttributeValues?.[":pk"];
      return {
        Items: rows
          .filter(
            (row) =>
              analyticsEventPartition(row.id, row.received_at_ms) === partition,
          )
          .map((row) => ({
            ...row,
            expires_at_s: 0,
            pk: partition,
            sk: `${String(row.received_at_ms).padStart(13, "0")}#${row.id}`,
          })),
      };
    });

    await expect(
      persistence.scan({
        after: {
          id: "event-a",
          receivedAtMs: Date.UTC(2026, 0, 31, 23, 59),
        },
        beforeReceivedAtMs: Date.UTC(2026, 1, 3),
        limit: 3,
      }),
    ).resolves.toEqual(rows.slice(1));

    expect(dynamodb.commandCalls(QueryCommand).length).toBeGreaterThan(1);
    expect(
      dynamodb
        .commandCalls(QueryCommand)
        .every(
          ({ args }) =>
            args[0].input.KeyConditionExpression ===
            "#pk = :pk AND #sk BETWEEN :after AND :before",
        ),
    ).toBe(true);
  });

  it("rejects reads and writes until init records the Analytics schema", async () => {
    const persistence = createPersistence();
    dynamodb.on(GetCommand).resolves({});

    await expect(
      persistence.scan({ beforeReceivedAtMs: 1_000, limit: 1 }),
    ).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
    expect(dynamodb.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it("checks the Analytics schema once per persistence instance", async () => {
    // Given
    const persistence = createPersistence();
    dynamodb.on(PutCommand).resolves({});
    dynamodb.on(QueryCommand).resolves({ Items: [] });

    // When
    await persistence.append(unchangedRow("event-a", 1_000));
    await persistence.scan({ beforeReceivedAtMs: 2_000, limit: 1 });
    await persistence.scan({ beforeReceivedAtMs: 2_000, limit: 1 });

    // Then
    expect(dynamodb.commandCalls(GetCommand)).toHaveLength(1);
  });
});
