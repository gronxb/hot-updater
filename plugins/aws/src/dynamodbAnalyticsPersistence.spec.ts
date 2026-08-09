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
  DYNAMODB_ANALYTICS_PARTITION,
  DYNAMODB_ANALYTICS_SCHEMA_VERSION,
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

  it("appends an immutable event in the ordered Analytics partition", async () => {
    const persistence = createPersistence();
    const row = unchangedRow("event-a", 1_000);
    dynamodb.on(PutCommand).resolves({});

    await persistence.append(row);

    expect(dynamodb.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: "hot-updater-metadata",
      ConditionExpression: "attribute_not_exists(#pk)",
      Item: {
        ...row,
        pk: DYNAMODB_ANALYTICS_PARTITION,
        sk: "0000000001000#event-a",
      },
    });
  });

  it("scans with a strict cutoff and exclusive ordered cursor", async () => {
    const persistence = createPersistence();
    const rows = [
      unchangedRow("event-b", 1_000),
      unchangedRow("event-c", 2_000),
    ];
    dynamodb.on(QueryCommand).resolves({
      Items: rows.map((row) => ({
        ...row,
        pk: DYNAMODB_ANALYTICS_PARTITION,
        sk: `${String(row.received_at_ms).padStart(13, "0")}#${row.id}`,
      })),
    });

    await expect(
      persistence.scan({
        after: { id: "event-a", receivedAtMs: 1_000 },
        beforeReceivedAtMs: 3_000,
        limit: 2,
      }),
    ).resolves.toEqual(rows);

    expect(dynamodb.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject(
      {
        ExpressionAttributeValues: {
          ":after": "0000000001000#event-a\u0000",
          ":before": "0000000003000#",
          ":pk": DYNAMODB_ANALYTICS_PARTITION,
        },
        KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :after AND :before",
        Limit: 2,
        ScanIndexForward: true,
      },
    );
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
