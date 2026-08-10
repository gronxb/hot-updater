import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  managedAccessKeyId,
  type ManagedAccessKeyRecord,
  type ManagedAccessKeyStore,
} from "@hot-updater/better-auth/managed";

import type { DynamoDBStore } from "./dynamodbDatabaseStore";

const ACCESS_KEY_CATALOG_PARTITION = "_hot-updater#managed_access_keys";
const ACCESS_KEY_RECORD_SORT_KEY = "record";

const accessKeyPartition = (hash: string): string =>
  `managed_access_key#${hash}`;

const authItem = (record: ManagedAccessKeyRecord) => ({
  ...record,
  pk: accessKeyPartition(record.hash),
  sk: ACCESS_KEY_RECORD_SORT_KEY,
});

const catalogItem = (record: ManagedAccessKeyRecord) => ({
  ...record,
  pk: ACCESS_KEY_CATALOG_PARTITION,
  sk: record.id,
});

const parseRecord = (
  value: Record<string, unknown>,
  source: "auth" | "catalog",
): ManagedAccessKeyRecord => {
  const {
    createdAt,
    enabled,
    hash,
    id,
    name,
    pk,
    prefix,
    revokedAt,
    role,
    sk,
  } = value;
  if (
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    typeof enabled !== "boolean" ||
    typeof hash !== "string" ||
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof prefix !== "string" ||
    (revokedAt !== null &&
      (typeof revokedAt !== "number" || !Number.isSafeInteger(revokedAt))) ||
    role !== "client" ||
    id !== managedAccessKeyId(hash) ||
    (source === "auth" &&
      (pk !== accessKeyPartition(hash) || sk !== ACCESS_KEY_RECORD_SORT_KEY)) ||
    (source === "catalog" && (pk !== ACCESS_KEY_CATALOG_PARTITION || sk !== id))
  ) {
    throw new TypeError("Invalid DynamoDB managed access-key item.");
  }
  return { createdAt, enabled, hash, id, name, prefix, revokedAt, role };
};

const isTransactionCanceled = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error, "name") === "TransactionCanceledException";

export const createDynamoDBManagedAccessKeyStore = (
  store: DynamoDBStore,
  options: {
    readonly onRevoke?: () => Promise<void>;
  } = {},
): ManagedAccessKeyStore => {
  const findByHash = async (
    hash: string,
  ): Promise<ManagedAccessKeyRecord | null> => {
    const { Item } = await store.client.send(
      new GetCommand({
        ConsistentRead: true,
        Key: {
          pk: accessKeyPartition(hash),
          sk: ACCESS_KEY_RECORD_SORT_KEY,
        },
        TableName: store.tableName,
      }),
    );
    return Item === undefined ? null : parseRecord(Item, "auth");
  };

  return {
    async create(record) {
      if ((await findByHash(record.hash)) !== null) return "existing";
      try {
        await store.client.send(
          new TransactWriteCommand({
            TransactItems: [authItem(record), catalogItem(record)].map(
              (Item) => ({
                Put: {
                  ConditionExpression:
                    "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
                  ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
                  Item,
                  TableName: store.tableName,
                },
              }),
            ),
          }),
        );
        return "created";
      } catch (error) {
        if (isTransactionCanceled(error) && (await findByHash(record.hash))) {
          return "existing";
        }
        throw error;
      }
    },
    findByHash,
    async list() {
      const records: ManagedAccessKeyRecord[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await store.client.send(
          new QueryCommand({
            ConsistentRead: true,
            ExclusiveStartKey: exclusiveStartKey,
            ExpressionAttributeNames: { "#pk": "pk" },
            ExpressionAttributeValues: {
              ":pk": ACCESS_KEY_CATALOG_PARTITION,
            },
            KeyConditionExpression: "#pk = :pk",
            TableName: store.tableName,
          }),
        );
        records.push(
          ...(page.Items ?? []).map((item) => parseRecord(item, "catalog")),
        );
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey !== undefined);
      return records.sort(
        (left, right) =>
          right.createdAt - left.createdAt || left.id.localeCompare(right.id),
      );
    },
    async revoke({ id, revokedAt }) {
      const hash = id.startsWith("managed-client-")
        ? id.slice("managed-client-".length)
        : "";
      if (managedAccessKeyId(hash) !== id) return null;
      const current = await findByHash(hash);
      if (current === null || !current.enabled || current.revokedAt !== null) {
        return current;
      }
      const update = {
        ConditionExpression: "attribute_exists(#pk) AND #enabled = :enabled",
        ExpressionAttributeNames: {
          "#enabled": "enabled",
          "#pk": "pk",
          "#revokedAt": "revokedAt",
        },
        ExpressionAttributeValues: {
          ":disabled": false,
          ":enabled": true,
          ":revokedAt": revokedAt,
        },
        TableName: store.tableName,
        UpdateExpression: "SET #enabled = :disabled, #revokedAt = :revokedAt",
      } as const;
      try {
        await store.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  ...update,
                  Key: {
                    pk: accessKeyPartition(hash),
                    sk: ACCESS_KEY_RECORD_SORT_KEY,
                  },
                },
              },
              {
                Update: {
                  ...update,
                  Key: { pk: ACCESS_KEY_CATALOG_PARTITION, sk: id },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (!isTransactionCanceled(error)) throw error;
        return findByHash(hash);
      }
      const revoked = { ...current, enabled: false, revokedAt };
      await options.onRevoke?.();
      return revoked;
    },
  };
};
