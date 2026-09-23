import {
  CreateTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type {
  KeyValueStore,
  KvCondition,
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
const column = (name: string) => (name.startsWith(".") ? name.slice(1) : name);

const toItem = (key: KvKey, row: StoredRow) => ({
  ...Object.fromEntries(
    Object.entries(row).map(([name, value]) => [attribute(name), value]),
  ),
  pk: key.pk,
  sk: key.sk,
});

const toRow = (item: Record<string, unknown>): StoredRow =>
  Object.fromEntries(
    Object.entries(item)
      .filter(([name]) => name !== "pk" && name !== "sk")
      .map(([name, value]) => [column(name), value]),
  ) as StoredRow;

const idOf = ({ pk, sk }: KvKey) => JSON.stringify([pk, sk]);

/** Expression text with every name and value bound, so no column clashes with a reserved word. */
const expression = () => {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  return {
    names,
    values,
    name: (text: string) => {
      const token = `#n${Object.keys(names).length}`;
      names[token] = text;
      return token;
    },
    value: (value: unknown) => {
      const token = `:v${Object.keys(values).length}`;
      values[token] = value;
      return token;
    },
  };
};

const conditionOf = (
  condition: KvCondition | undefined,
  bind: ReturnType<typeof expression>,
) => {
  if (condition === undefined) return undefined;
  if ("v" in condition) {
    return `${bind.name(attribute("_v"))} = ${bind.value(condition.v)}`;
  }
  return `${condition.exists ? "attribute_exists" : "attribute_not_exists"}(${bind.name("pk")})`;
};

type TransactItem = NonNullable<
  TransactWriteCommandInput["TransactItems"]
>[number];

/** One transaction item; every expression binds its own names and values. */
const toTransactItem = (tableName: string, op: KvOp): TransactItem => {
  const bind = expression();
  const condition = conditionOf(op.condition, bind);
  const bound = <T extends object>(extra: T) => ({
    TableName: tableName,
    ...extra,
    ...(condition === undefined ? {} : { ConditionExpression: condition }),
    ...(Object.keys(bind.names).length === 0
      ? {}
      : { ExpressionAttributeNames: bind.names }),
    ...(Object.keys(bind.values).length === 0
      ? {}
      : { ExpressionAttributeValues: bind.values }),
  });
  const Key = { pk: op.key.pk, sk: op.key.sk };
  switch (op.type) {
    case "put":
      return { Put: bound({ Item: toItem(op.key, op.value) }) };
    case "delete":
      return { Delete: bound({ Key }) };
    case "check":
      return {
        ConditionCheck: { ...bound({ Key }), ConditionExpression: condition! },
      };
    case "add": {
      // A missing item starts from `init`; a missing attribute counts from 0.
      const init = op.init ?? {};
      const sets = [
        ...Object.entries(op.by).map(([name, delta]) => {
          const path = bind.name(attribute(name));
          const start = bind.value(Number(init[name] ?? 0));
          return `${path} = if_not_exists(${path}, ${start}) + ${bind.value(delta)}`;
        }),
        ...Object.entries(init)
          .filter(([name]) => !(name in op.by))
          .map(([name, value]) => {
            const path = bind.name(attribute(name));
            return `${path} = if_not_exists(${path}, ${bind.value(value)})`;
          }),
      ];
      return {
        Update: bound({ Key, UpdateExpression: `SET ${sets.join(", ")}` }),
      };
    }
  }
};

/** Cancellation codes a retry of the whole write can clear. */
const TRANSIENT = new Set([
  "TransactionConflict",
  "ThrottlingError",
  "ProvisionedThroughputExceeded",
  "RequestLimitExceeded",
]);
const TRANSIENT_ERRORS = new Set([
  "TransactionInProgressException",
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "InternalServerError",
]);

/** A missing table reads as one to the schema fence, like SQL's 42P01. */
const missingTable = (error: unknown): never => {
  throw (error as { name?: string }).name === "ResourceNotFoundException"
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
          if (round > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, 2 ** round * 10),
            );
          }
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
      const bind = expression();
      // DynamoDB refuses a bound name the expression does not use.
      const sk = () => bind.name("sk");
      const range =
        gte !== undefined && lt !== undefined
          ? ` AND ${sk()} BETWEEN ${bind.value(gte)} AND ${bind.value(lt)}`
          : gte !== undefined
            ? ` AND ${sk()} >= ${bind.value(gte)}`
            : lt !== undefined
              ? ` AND ${sk()} < ${bind.value(lt)}`
              : "";
      const condition = `${bind.name("pk")} = ${bind.value(pk)}${range}`;
      let start: Record<string, unknown> | undefined =
        after === undefined ? undefined : { pk, sk: after };
      for (;;) {
        const result = await documents
          .send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: condition,
              ExpressionAttributeNames: bind.names,
              ExpressionAttributeValues: bind.values,
              ScanIndexForward: order === "asc",
              ConsistentRead: true,
              Limit: Math.min(limit, nativePageSize ?? limit),
              ExclusiveStartKey: start,
            }),
          )
          .catch(missingTable);
        // BETWEEN includes `lt`, which the range excludes.
        const items = (result.Items ?? [])
          .filter((item) => lt === undefined || item.sk !== lt)
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
        const { name, CancellationReasons: reasons } = error as {
          name?: string;
          CancellationReasons?: readonly { Code?: string }[];
        };
        if (name === "TransactionCanceledException" && reasons) {
          const failed = reasons.findIndex(
            ({ Code }) => Code === "ConditionalCheckFailed",
          );
          if (failed !== -1) return { ok: false, failedOp: failed };
          if (reasons.some(({ Code }) => Code && TRANSIENT.has(Code))) {
            return { ok: false, retry: true };
          }
        }
        if (name && TRANSIENT_ERRORS.has(name))
          return { ok: false, retry: true };
        return missingTable(error);
      }
    },
    migrations: {
      /** Creates the table for local and test runs; `hot-updater init` creates it in AWS. */
      async apply() {
        try {
          await client.send(new DescribeTableCommand({ TableName: tableName }));
          return;
        } catch (error) {
          if (
            (error as { name?: string }).name !== "ResourceNotFoundException"
          ) {
            throw error;
          }
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
        for (let round = 0; ; round += 1) {
          const { Table } = await client.send(
            new DescribeTableCommand({ TableName: tableName }),
          );
          if (Table?.TableStatus === "ACTIVE") return;
          if (round > 120)
            throw new Error(`${tableName} did not become active.`);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      },
    },
  };
};
