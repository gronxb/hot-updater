import {
  CreateTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  KeyValueStore,
  KvKey,
  KvOp,
  StoredRow,
} from "@hot-updater/server/database";

/** DynamoDB's limits: 100 items and 4 MB a transaction, 400 KB an item, and 2,048- and 1,024-byte keys. */
export const DYNAMODB_LIMITS = {
  items: 100,
  bytes: 4_000_000,
  itemBytes: 400_000,
  keyBytes: { pk: 2_048, sk: 1_024 },
} as const;

/** BatchGetItem takes 100 keys a call. */
const GET_BATCH = 100;

/** A column named like a key attribute is stored with a leading dot, which no column name has. */
const attribute = (column: string) =>
  column === "pk" || column === "sk" ? `.${column}` : column;
const renamed = (record: object, rename: (name: string) => string) =>
  Object.fromEntries(
    Object.entries(record).map(([name, value]) => [rename(name), value]),
  );
const toItem = (key: KvKey, row: StoredRow) => ({
  ...renamed(row, attribute),
  pk: key.pk,
  sk: key.sk,
});
const toRow = ({ pk: _pk, sk: _sk, ...item }: Record<string, unknown>) =>
  renamed(item, (name) => name.replace(/^\./, "")) as StoredRow;

const idOf = ({ pk, sk }: KvKey) => JSON.stringify([pk, sk]);

const nameOf = (error: unknown) => (error as { name?: string }).name;

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * One transaction item. Its expressions bind every column name and value, so
 * no column clashes with a reserved word; `pk` and `sk` are none.
 */
const toTransactItem = (tableName: string, op: KvOp) => {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const binder =
    <T>(map: Record<string, T>, prefix: string) =>
    (entry: T) => {
      const token = `${prefix}${Object.keys(map).length}`;
      map[token] = entry;
      return token;
    };
  const name = binder(names, "#n");
  const value = binder(values, ":v");
  const { condition } = op;
  const guard =
    condition === undefined
      ? undefined
      : "v" in condition
        ? `${name("_v")} = ${value(condition.v)}`
        : `${condition.exists ? "attribute_exists" : "attribute_not_exists"}(pk)`;
  const item = <T extends object>(fields: T) => ({
    TableName: tableName,
    ConditionExpression: guard,
    ...fields,
    // DynamoDB refuses an empty map; the SDK leaves out an undefined member.
    ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
    ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
  });
  const Key = { pk: op.key.pk, sk: op.key.sk };
  switch (op.type) {
    case "put":
      return { Put: item({ Item: toItem(op.key, op.value) }) };
    case "delete":
      return { Delete: item({ Key }) };
    case "check":
      return { ConditionCheck: item({ Key, ConditionExpression: guard! }) };
    case "add": {
      // A missing item starts from `init`; a missing attribute counts from 0.
      const init = op.init ?? {};
      const sets = Object.keys({ ...init, ...op.by }).map((column) => {
        const path = name(attribute(column));
        const by = op.by[column];
        if (by === undefined) {
          return `${path} = if_not_exists(${path}, ${value(init[column])})`;
        }
        const start = value(Number(init[column] ?? 0));
        return `${path} = if_not_exists(${path}, ${start}) + ${value(by)}`;
      });
      const UpdateExpression = `SET ${sets.join(", ")}`;
      return { Update: item({ Key, UpdateExpression }) };
    }
  }
};

/** Errors, and cancellation reasons, that a retry of the whole write can clear. */
const TRANSIENT = new Set<string | undefined>([
  "TransactionConflict",
  "ThrottlingError",
  "ProvisionedThroughputExceeded",
  "RequestLimitExceeded",
  "TransactionInProgressException",
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "InternalServerError",
]);

/** A missing table reads as one to the schema fence, like SQL's 42P01. */
const missingTable = (error: unknown): never => {
  throw nameOf(error) === "ResourceNotFoundException"
    ? Object.assign(new Error((error as Error).message, { cause: error }), {
        code: "42P01",
      })
    : error;
};

export interface DynamoDBStoreOptions {
  readonly client: DynamoDBClient;
  readonly tableName: string;
  /** Test-only: the most items one `query` page returns. */
  readonly nativePageSize?: number;
}

/**
 * The key-value store over one DynamoDB table keyed by `pk` and `sk`, with
 * no secondary index. Reads are strongly consistent; a write is one
 * `TransactWriteItems` with a client request token.
 */
export const createDynamoDBStore = ({
  client,
  tableName,
  nativePageSize,
}: DynamoDBStoreOptions): KeyValueStore => {
  const documents = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    id: "dynamoDB",
    limits: DYNAMODB_LIMITS,
    async get(keys) {
      const found = new Map<string, StoredRow>();
      const unique = [...new Map(keys.map((key) => [idOf(key), key])).values()];
      for (let at = 0; at < unique.length; at += GET_BATCH) {
        let pending: Record<string, unknown>[] = unique
          .slice(at, at + GET_BATCH)
          .map(({ pk, sk }) => ({ pk, sk }));
        for (let round = 0; pending.length > 0; round += 1) {
          if (round > 0) await sleep(2 ** round * 10);
          const result = await documents
            .send(
              new BatchGetCommand({
                RequestItems: {
                  [tableName]: { Keys: pending, ConsistentRead: true },
                },
              }),
            )
            .catch(missingTable);
          for (const item of result.Responses?.[tableName] ?? []) {
            found.set(idOf(item as unknown as KvKey), toRow(item));
          }
          pending = result.UnprocessedKeys?.[tableName]?.Keys ?? [];
        }
      }
      return keys.map((key) => found.get(idOf(key)) ?? null);
    },
    async query({ pk, gte, lt, order, limit, after }) {
      // `pk` and `sk` are no reserved words, so the condition names them as is.
      let condition = "pk = :pk";
      if (gte !== undefined && lt !== undefined)
        condition += " AND sk BETWEEN :gte AND :lt";
      else if (gte !== undefined) condition += " AND sk >= :gte";
      else if (lt !== undefined) condition += " AND sk < :lt";
      let start: Record<string, unknown> | undefined =
        after === undefined ? undefined : { pk, sk: after };
      for (;;) {
        const result = await documents
          .send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: condition,
              // The client drops an undefined bound, which DynamoDB would refuse as unused.
              ExpressionAttributeValues: { ":pk": pk, ":gte": gte, ":lt": lt },
              ScanIndexForward: order === "asc",
              ConsistentRead: true,
              Limit: Math.min(limit, nativePageSize ?? limit),
              ExclusiveStartKey: start,
            }),
          )
          .catch(missingTable);
        // BETWEEN includes `lt`, which the range excludes.
        const items = (result.Items ?? [])
          .filter((item) => item.sk !== lt)
          .map((item) => ({ sk: item.sk as string, value: toRow(item) }));
        start = result.LastEvaluatedKey;
        // A page that held only `lt` is not the range's end.
        if (items.length > 0 || start === undefined) {
          return { items, more: start !== undefined };
        }
      }
    },
    async write(ops) {
      try {
        await documents.send(
          new TransactWriteCommand({
            TransactItems: ops.map((op) => toTransactItem(tableName, op)),
            ClientRequestToken: crypto.randomUUID(),
          }),
        );
        return { ok: true };
      } catch (error) {
        const { CancellationReasons = [] } = error as {
          CancellationReasons?: { Code?: string }[];
        };
        const codes = CancellationReasons.map(({ Code }) => Code);
        const failed = codes.indexOf("ConditionalCheckFailed");
        if (failed !== -1) return { ok: false, failedOp: failed };
        return [nameOf(error), ...codes].some((code) => TRANSIENT.has(code))
          ? { ok: false, retry: true }
          : missingTable(error);
      }
    },
    migrations: {
      /** Creates the table for local and test runs; `hot-updater init` creates it in AWS. */
      async apply() {
        try {
          await client.send(new DescribeTableCommand({ TableName: tableName }));
          return;
        } catch (error) {
          if (nameOf(error) !== "ResourceNotFoundException") throw error;
        }
        await client.send(
          new CreateTableCommand({
            TableName: tableName,
            AttributeDefinitions: [
              { AttributeName: "pk", AttributeType: "S" },
              { AttributeName: "sk", AttributeType: "S" },
            ],
            KeySchema: [
              { AttributeName: "pk", KeyType: "HASH" },
              { AttributeName: "sk", KeyType: "RANGE" },
            ],
            BillingMode: "PAY_PER_REQUEST",
          }),
        );
        await waitUntilTableExists(
          { client, maxWaitTime: 120, minDelay: 1, maxDelay: 1 },
          { TableName: tableName },
        );
      },
    },
  };
};
