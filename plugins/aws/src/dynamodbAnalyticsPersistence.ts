import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  AnalyticsSchemaNotReadyError,
  parseBundleEventPersistenceRow,
  type AnalyticsPersistence,
  type BundleEventPersistenceRow,
} from "@hot-updater/analytics/provider";

import type { DynamoDBStore } from "./dynamodbDatabaseStore";

export const DYNAMODB_ANALYTICS_SCHEMA_VERSION = "2";
export const DYNAMODB_ANALYTICS_PARTITION = "analytics#bundle_events";
export const DYNAMODB_ANALYTICS_SCHEMA_KEY = {
  pk: "_hot-updater",
  sk: "schema.analytics",
} as const;

export class InvalidDynamoDBAnalyticsItemError extends Error {
  readonly name = "InvalidDynamoDBAnalyticsItemError";

  constructor() {
    super("DynamoDB Analytics item key does not match its event row");
  }
}

const eventSortKey = (receivedAtMs: number, id = ""): string =>
  `${String(receivedAtMs).padStart(13, "0")}#${id}`;

const assertAnalyticsReady = async (store: DynamoDBStore): Promise<void> => {
  const { Item } = await store.client.send(
    new GetCommand({
      TableName: store.tableName,
      Key: DYNAMODB_ANALYTICS_SCHEMA_KEY,
      ProjectionExpression: "#value",
      ExpressionAttributeNames: { "#value": "value" },
    }),
  );
  const componentVersion = typeof Item?.value === "string" ? Item.value : null;
  if (componentVersion !== DYNAMODB_ANALYTICS_SCHEMA_VERSION) {
    throw new AnalyticsSchemaNotReadyError({
      componentVersion,
      fingerprint: null,
      legacyVersion: null,
    });
  }
};

const parseEventItem = (item: Record<string, unknown>) => {
  const { pk, sk, ...row } = item;
  const parsed = parseBundleEventPersistenceRow(row);
  if (
    pk !== DYNAMODB_ANALYTICS_PARTITION ||
    sk !== eventSortKey(parsed.received_at_ms, parsed.id)
  ) {
    throw new InvalidDynamoDBAnalyticsItemError();
  }
  return parsed;
};

export const createDynamoDBAnalyticsPersistence = (
  store: DynamoDBStore,
): AnalyticsPersistence => {
  let schemaReadiness: Promise<void> | undefined;
  const ensureAnalyticsReady = (): Promise<void> => {
    schemaReadiness ??= assertAnalyticsReady(store).catch((error) => {
      schemaReadiness = undefined;
      throw error;
    });
    return schemaReadiness;
  };

  return {
    async append(row: BundleEventPersistenceRow) {
      await ensureAnalyticsReady();
      await store.client.send(
        new PutCommand({
          TableName: store.tableName,
          Item: {
            ...row,
            pk: DYNAMODB_ANALYTICS_PARTITION,
            sk: eventSortKey(row.received_at_ms, row.id),
          },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        }),
      );
    },
    async scan(input) {
      await ensureAnalyticsReady();
      const after = input.after;
      const { Items = [] } = await store.client.send(
        new QueryCommand({
          TableName: store.tableName,
          KeyConditionExpression:
            after === undefined
              ? "#pk = :pk AND #sk < :before"
              : "#pk = :pk AND #sk BETWEEN :after AND :before",
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": DYNAMODB_ANALYTICS_PARTITION,
            ":before": eventSortKey(input.beforeReceivedAtMs),
            ...(after === undefined
              ? {}
              : {
                  ":after": `${eventSortKey(after.receivedAtMs, after.id)}\u0000`,
                }),
          },
          Limit: input.limit,
          ScanIndexForward: true,
        }),
      );
      return Items.map(parseEventItem);
    },
  };
};
