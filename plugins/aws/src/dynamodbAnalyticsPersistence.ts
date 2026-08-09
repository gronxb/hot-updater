import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  AnalyticsSchemaNotReadyError,
  parseBundleEventPersistenceRow,
  type AnalyticsPersistence,
  type BundleEventPersistenceRow,
} from "@hot-updater/analytics/provider";

import type { DynamoDBStore } from "./dynamodbDatabaseStore";

export const DYNAMODB_ANALYTICS_SCHEMA_VERSION = "3";
export const DYNAMODB_ANALYTICS_PARTITION_PREFIX = "analytics#bundle_events";
export const DYNAMODB_ANALYTICS_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const DYNAMODB_ANALYTICS_SHARD_COUNT = 4;
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

const startOfUtcMonth = (receivedAtMs: number): number => {
  const date = new Date(receivedAtMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth());
};

const nextUtcMonth = (receivedAtMs: number): number => {
  const date = new Date(receivedAtMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1);
};

const monthName = (receivedAtMs: number): string => {
  const date = new Date(receivedAtMs);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

const eventShard = (id: string): number => {
  let hash = 2_166_136_261;
  for (const character of id) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % DYNAMODB_ANALYTICS_SHARD_COUNT;
};

const analyticsPartition = (monthStartMs: number, shard: number): string =>
  `${DYNAMODB_ANALYTICS_PARTITION_PREFIX}#${monthName(monthStartMs)}#${shard}`;

export const analyticsEventPartition = (
  id: string,
  receivedAtMs: number,
): string => analyticsPartition(startOfUtcMonth(receivedAtMs), eventShard(id));

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
  const { expires_at_s: _expiresAt, pk, sk, ...row } = item;
  const parsed = parseBundleEventPersistenceRow(row);
  if (
    pk !== analyticsEventPartition(parsed.id, parsed.received_at_ms) ||
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
            expires_at_s:
              Math.floor(row.received_at_ms / 1_000) +
              DYNAMODB_ANALYTICS_RETENTION_SECONDS,
            pk: analyticsEventPartition(row.id, row.received_at_ms),
            sk: eventSortKey(row.received_at_ms, row.id),
          },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": "pk" },
        }),
      );
    },
    async scan(input) {
      await ensureAnalyticsReady();
      const retentionStartMs = Math.max(
        0,
        input.beforeReceivedAtMs - DYNAMODB_ANALYTICS_RETENTION_SECONDS * 1_000,
      );
      const lowerReceivedAtMs = Math.max(
        retentionStartMs,
        input.after?.receivedAtMs ?? retentionStartMs,
      );
      const rows: BundleEventPersistenceRow[] = [];
      for (
        let monthStartMs = startOfUtcMonth(lowerReceivedAtMs);
        monthStartMs < input.beforeReceivedAtMs && rows.length < input.limit;
        monthStartMs = nextUtcMonth(monthStartMs)
      ) {
        const lowerSortKey =
          input.after !== undefined &&
          startOfUtcMonth(input.after.receivedAtMs) === monthStartMs
            ? eventSortKey(input.after.receivedAtMs, input.after.id)
            : eventSortKey(Math.max(lowerReceivedAtMs, monthStartMs));
        const upperSortKey = eventSortKey(
          Math.min(input.beforeReceivedAtMs, nextUtcMonth(monthStartMs)),
        );
        const pages = await Promise.all(
          Array.from({ length: DYNAMODB_ANALYTICS_SHARD_COUNT }, (_, shard) =>
            store.client.send(
              new QueryCommand({
                TableName: store.tableName,
                KeyConditionExpression:
                  "#pk = :pk AND #sk BETWEEN :after AND :before",
                ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
                ExpressionAttributeValues: {
                  ":after": lowerSortKey,
                  ":before": upperSortKey,
                  ":pk": analyticsPartition(monthStartMs, shard),
                },
                Limit: input.limit + (input.after === undefined ? 0 : 1),
                ScanIndexForward: true,
              }),
            ),
          ),
        );
        rows.push(
          ...pages
            .flatMap(({ Items = [] }) => Items.map(parseEventItem))
            .filter(
              (row) =>
                row.received_at_ms < input.beforeReceivedAtMs &&
                (input.after === undefined ||
                  row.received_at_ms > input.after.receivedAtMs ||
                  (row.received_at_ms === input.after.receivedAtMs &&
                    row.id > input.after.id)),
            )
            .sort(
              (left, right) =>
                left.received_at_ms - right.received_at_ms ||
                left.id.localeCompare(right.id),
            )
            .slice(0, input.limit - rows.length),
        );
      }
      return rows;
    },
  };
};
