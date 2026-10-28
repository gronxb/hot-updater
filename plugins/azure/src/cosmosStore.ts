import { createHash } from "node:crypto";

import type {
  Container,
  ContainerDefinition,
  CosmosClient,
  IndexingPolicy,
  JSONObject,
  OperationInput,
  PatchOperation,
} from "@azure/cosmos";
import {
  encodeKvKey,
  type KeyValueStore,
  type KvKey,
  type KvOp,
  SETTINGS_TABLE,
  type StoredRow,
  toolingTargetOf,
} from "@hot-updater/plugin-core";

/**
 * Cosmos DB commits a transactional batch only inside one logical
 * partition, and the engine's writes span tables and their index items, so
 * every item shares this partition key value. One logical partition holds
 * at most 20 GB and serves at most 10,000 RU/s.
 */
export const COSMOS_PARTITION = "hot-updater";

/** The container's partition key path, whose value is always `COSMOS_PARTITION`. */
export const COSMOS_PARTITION_KEY_PATH = "/partition";

/**
 * A transactional batch takes 100 operations and a 2 MB request, an item
 * 2 MB. The kit measures a row's JSON, but a map or array value is stored
 * as JSON text whose quotes and backslashes escape again, so an item takes
 * up to twice the measured bytes; the rest leaves room for each item's
 * envelope. Every op takes one operation but an `exists: false` check or
 * delete, which takes two; the engine writes neither.
 */
export const COSMOS_LIMITS = {
  items: 100,
  bytes: 1_000_000,
  itemBytes: 1_000_000,
} as const;

/** The most operations one transactional batch takes. */
const BATCH_OPERATIONS = 100;

/** The most bytes of operations a transactional batch request takes, below its 2 MB. */
const BATCH_BYTES = 2_000_000;

const encoder = new TextEncoder();

/** A query reads at most this many ids a call. */
const GET_BATCH = 100;

/** A patch takes at most 10 operations. */
const PATCH_OPERATIONS = 10;

/**
 * The container's indexing: only the id `get` looks up, and the partition
 * and sort keys a range read filters and orders by, through one composite
 * index that serves either order. Rows are never filtered on, so they are not indexed.
 */
export const COSMOS_INDEXING_POLICY: IndexingPolicy = {
  indexingMode: "consistent",
  automatic: true,
  // `id` is always indexed, and Cosmos DB refuses a path for it.
  includedPaths: [{ path: "/pk/?" }, { path: "/sk/?" }],
  excludedPaths: [{ path: "/*" }],
  compositeIndexes: [
    [
      { path: "/pk", order: "ascending" },
      { path: "/sk", order: "ascending" },
    ],
  ],
};

/** An item's id: a hash of its key, since keys may hold `/` and Cosmos DB ids take at most 1,023 bytes. */
export const cosmosItemId = ({ pk, sk }: KvKey) =>
  createHash("sha256")
    .update(JSON.stringify([pk, sk]))
    .digest("hex");

/**
 * An item is `{ id, partition, pk, sk, row, ttl, expireAt }`. Row values
 * that are maps or arrays become JSON text inside a map, so a read returns
 * them exactly as written, map key order included.
 */
const encode = (value: unknown) =>
  value !== null && typeof value === "object"
    ? { json: JSON.stringify(value) }
    : value;
const decode = (value: unknown) =>
  value !== null && typeof value === "object" && "json" in value
    ? JSON.parse(String((value as { json: unknown }).json))
    : value;

const encodeRow = (row: StoredRow) =>
  Object.fromEntries(
    Object.entries(row).map(([name, value]) => [name, encode(value)]),
  ) as JSONObject;

const toRow = (row: unknown): StoredRow =>
  Object.fromEntries(
    Object.entries((row ?? {}) as Record<string, unknown>).map(
      ([name, value]) => [name, decode(value)],
    ),
  ) as StoredRow;

/**
 * The least TTL an item gets. Cosmos DB hides an item the moment its TTL
 * passes, where DynamoDB and Firestore delete expired items within a day or
 * two and read them until then; an item written already past its retention,
 * such as a late Insights event, lives this long rather than vanishing
 * under the write that made it.
 */
const MIN_TTL_SECONDS = 24 * 60 * 60;

/**
 * Cosmos DB's TTL counts seconds from an item's last write, so every write
 * sets it again from the absolute `expireAt`; `-1` never expires.
 */
const ttlOf = (expireAt: number | null | undefined) =>
  expireAt === null || expireAt === undefined
    ? -1
    : Math.max(MIN_TTL_SECONDS, Math.ceil((expireAt - Date.now()) / 1000));

/** The item Cosmos DB stores for a row. */
export const toItem = (key: KvKey, row: StoredRow, expiresAt?: number) => ({
  id: cosmosItemId(key),
  partition: COSMOS_PARTITION,
  pk: key.pk,
  sk: key.sk,
  row: encodeRow(row),
  expireAt: expiresAt ?? null,
  ttl: ttlOf(expiresAt),
});

/** An item that exists only between a Create and a Delete of one batch, to guard or to delete a key whether or not it exists. */
const placeholderOf = (key: KvKey) => ({
  id: cosmosItemId(key),
  partition: COSMOS_PARTITION,
});

/** Ids as an `IN` list: they are hex digests, so they need no parameters. */
const idList = (ids: readonly string[]) =>
  ids.map((id) => JSON.stringify(id)).join(", ");

/** A JSON Pointer to a row column. */
const columnPath = (name: string) =>
  `/row/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;

const guardOf = (v: number) => `FROM c WHERE c.row._v = ${JSON.stringify(v)}`;

/** Statuses a rerun of the whole write can clear: timeout, throttling, retry-with, unavailable. */
const TRANSIENT = new Set([408, 429, 449, 503]);

/** An error's HTTP status, or its cause's: the SDK wraps some answers, such as a failed batch's. */
const statusOf = (error: unknown): unknown => {
  for (
    let at: unknown = error;
    at !== null && typeof at === "object";
    at = (at as { cause?: unknown }).cause
  ) {
    const { statusCode, code } = at as { statusCode?: unknown; code?: unknown };
    const status = statusCode ?? code;
    if (typeof status === "number") return status;
  }
  return undefined;
};

/** A missing database or container reads as a missing schema, like SQL's 42P01. */
const missingContainer = (error: unknown): never => {
  throw statusOf(error) === 404
    ? Object.assign(new Error((error as Error).message, { cause: error }), {
        code: "42P01",
      })
    : error;
};

/** The header of a container read that reports its index transformation, in percent. */
const INDEX_TRANSFORMATION_PROGRESS =
  "x-ms-documentdb-collection-index-transformation-progress";

/** How long a migration waits for a changed indexing policy to apply. */
const INDEX_TRANSFORMATION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Waits until Cosmos DB has applied a changed indexing policy: until then,
 * a query that orders by the new composite index fails.
 */
const waitForIndexTransformation = async (container: Container) => {
  const deadline = Date.now() + INDEX_TRANSFORMATION_TIMEOUT_MS;
  for (;;) {
    const { headers } = await container.read({ populateQuotaInfo: true });
    const progress = Number(headers[INDEX_TRANSFORMATION_PROGRESS] ?? 100);
    if (!(progress < 100)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Cosmos DB container ${container.id} is still indexing (${progress}%). Run the migration again once it finishes.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
};

/** The settings row that names the storage layout a container holds. */
const ENGINE_KEY = "schema.engine";

/** The `schema.engine` setting this version's storage layout writes. */
export const currentCosmosEngine = () =>
  toolingTargetOf([]).settings[ENGINE_KEY]!;

/**
 * Refuses a container whose fixed settings Hot Updater's items cannot live
 * under: unique keys, or another partition key.
 */
const assertContainerShape = (resource: ContainerDefinition) => {
  // Every item of a write shares a partition and many share a `pk`, so any
  // unique key would refuse them.
  if ((resource.uniqueKeyPolicy?.uniqueKeys?.length ?? 0) > 0) {
    throw new Error(
      `Cosmos DB container ${resource.id} has unique keys, which Hot Updater's items cannot satisfy. Use another container.`,
    );
  }
  const paths = resource.partitionKey?.paths ?? [];
  if (paths.length !== 1 || paths[0] !== COSMOS_PARTITION_KEY_PATH) {
    throw new Error(
      `Cosmos DB container ${resource.id} is partitioned by ${paths.join(
        ", ",
      )}; Hot Updater needs ${COSMOS_PARTITION_KEY_PATH}. Use another container.`,
    );
  }
};

/**
 * Refuses a container a migration must not touch: one with unique keys or
 * another partition key, one whose `schema.engine` is another storage
 * layout's, or a populated one without the setting. Writing the settings
 * would make the server read it as this layout. Read only, so init checks
 * a reused container before it creates anything. Point reads and a scan: a
 * reused container may index nothing yet, and the migration only fixes its
 * indexing once this check passes.
 */
export const assertCosmosContainerReusable = async (
  container: Container,
  expected: string,
) => {
  const missing = (error: unknown) =>
    (error as { code?: unknown }).code === 404;
  let existing: ContainerDefinition | undefined;
  try {
    existing = (await container.read()).resource;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  // No database or container yet: the migration creates them.
  if (existing === undefined) return;
  assertContainerShape(existing);
  // A missing item reads as no resource.
  const { resource } = await container
    .item(
      cosmosItemId({ pk: SETTINGS_TABLE.name, sk: encodeKvKey([ENGINE_KEY]) }),
      COSMOS_PARTITION,
    )
    .read<{ row?: { value?: unknown } }>()
    .catch((error: unknown) => {
      if (missing(error)) return { resource: undefined };
      throw error;
    });
  const found = resource?.row?.value;
  if (found !== undefined) {
    if (found !== expected) {
      throw new Error(
        `Cosmos DB container ${container.id} holds storage engine "${String(found)}"; this version writes "${expected}". Use the Hot Updater version that wrote it, or another container.`,
      );
    }
    return;
  }
  // Without the marker, any item in any partition, whatever its shape, is
  // data this layout did not write.
  const { resources } = await container.items
    .query<string>("SELECT TOP 1 VALUE c.id FROM c", {
      enableScanInQuery: true,
    })
    .fetchAll();
  if (resources.length > 0) {
    throw new Error(
      `Cosmos DB container ${container.id} holds items but no ${ENGINE_KEY} setting. Use an empty container.`,
    );
  }
};

export interface CosmosStoreOptions {
  /** The account's client, or what creates it on the store's first request. */
  readonly client: CosmosClient | (() => CosmosClient | Promise<CosmosClient>);
  readonly databaseId: string;
  /** The one container every item lives in. */
  readonly containerId: string;
  /**
   * The `schema.engine` setting this storage layout writes. A migration
   * refuses a reused container whose setting differs, or one that holds
   * other items without it.
   */
  readonly engine?: string;
  /** Test-only: the most items one `query` page returns. */
  readonly nativePageSize?: number;
}

/**
 * What a failed batch operation means: its op's condition failed, or the
 * state the write was planned on changed, so it reads and plans again.
 */
type OnFailure = "fail" | "replan";

/** One batch operation of a write, and the op it serves. */
interface Planned {
  readonly position: number;
  readonly operation: OperationInput;
  readonly onFailure: OnFailure;
}

/** What a write reads before it plans: an item's ETag, `_v`, and expiry. */
interface ReadState {
  readonly etag: string;
  readonly v: unknown;
  readonly expireAt: number | null;
  /** The stored row, read only for a wide add. */
  readonly row?: unknown;
}

/**
 * Whether an add takes more operations than one patch does. When its
 * patches would take a batch past its operations, it replaces the row it
 * read instead, one operation, which is what `COSMOS_LIMITS.items` counts.
 */
const isWideAdd = (op: KvOp) =>
  op.type === "add" &&
  Object.keys(op.by).length + (op.expiresAt === undefined ? 0 : 2) >
    PATCH_OPERATIONS;

/**
 * The PostgreSQL behind the vNext emulator aborts a batch that races
 * another one with these errors, having written nothing. Cosmos DB itself
 * runs the batches of a partition one at a time and never reports them.
 */
const emulatorAborted = (error: unknown) =>
  statusOf(error) === 500 &&
  /PostgresError\(SqlState\(E(25P02|40001|40P01)\)/.test(
    String(error instanceof Error ? error.message : error),
  );

/**
 * The key-value store over one Cosmos DB container of `{ pk, sk, row }`
 * items in one logical partition, read through the composite index on
 * (pk, sk). A write is one transactional batch whose operations carry most
 * ops' conditions themselves: a Create fails on an item that exists, a
 * Replace, Read or patch on one that is missing, and a patch whose
 * predicate finds another `_v`. Deletes and `_v` checks read their items
 * first, since a Delete of a missing item fails the batch and a patch
 * restarts the item's TTL, and so does an add wider than one patch, which
 * replaces the row it read.
 */
export const createCosmosStore = ({
  client,
  databaseId,
  containerId,
  engine,
  nativePageSize,
}: CosmosStoreOptions): KeyValueStore => {
  let opened:
    | Promise<{ client: CosmosClient; container: Container }>
    | undefined;
  // Opened on the first request, so a config loads without the connection.
  const open = () =>
    (opened ??= (async () => {
      const account = typeof client === "function" ? await client() : client;
      return {
        client: account,
        container: account.database(databaseId).container(containerId),
      };
    })().catch((error: unknown) => {
      opened = undefined;
      throw error;
    }));
  const container = async () => (await open()).container;

  /**
   * The state of the items `ids` names, by id, with the rows of `rowIds`;
   * a missing item has none.
   */
  const readStates = async (
    ids: readonly string[],
    rowIds: ReadonlySet<string>,
  ) => {
    const states = new Map<string, ReadState>();
    for (const [group, projection] of [
      [ids.filter((id) => !rowIds.has(id)), ""],
      [ids.filter((id) => rowIds.has(id)), ", c.row"],
    ] as const) {
      for (let at = 0; at < group.length; at += GET_BATCH) {
        const { resources } = await (
          await container()
        ).items
          .query<{
            id: string;
            etag: string;
            v?: unknown;
            expireAt?: number | null;
            row?: unknown;
          }>(
            `SELECT c.id, c._etag AS etag, c.row._v AS v, c.expireAt${projection} FROM c WHERE c.id IN (${idList(group.slice(at, at + GET_BATCH))})`,
            { partitionKey: COSMOS_PARTITION },
          )
          .fetchAll()
          .catch(missingContainer);
        for (const { id, etag, v, expireAt, row } of resources) {
          states.set(id, { etag, v, expireAt: expireAt ?? null, row });
        }
      }
    }
    return states;
  };

  /** Whether `op` reads its item before the write plans it. */
  const readsFirst = (op: KvOp) =>
    isWideAdd(op) ||
    (op.condition === undefined
      ? op.type === "delete" || op.type === "add"
      : "v" in op.condition && (op.type === "delete" || op.type === "check"));

  /**
   * The batch operations of `op`, given the state its item was read in;
   * `failed` when that state already fails its condition.
   */
  const operationsOf = (
    op: KvOp,
    state: ReadState | undefined,
    replaceWide: boolean,
  ):
    | readonly (readonly [OperationInput, OnFailure])[]
    | { readonly failed: true } => {
    const id = cosmosItemId(op.key);
    const condition = op.condition;
    const guard =
      condition !== undefined && "v" in condition
        ? guardOf(condition.v)
        : undefined;
    const patches = (
      operations: readonly PatchOperation[],
      onFailure: OnFailure,
    ) => {
      const chunks: (readonly [OperationInput, OnFailure])[] = [];
      for (let at = 0; at < operations.length; at += PATCH_OPERATIONS) {
        const operation: OperationInput = {
          operationType: "Patch",
          id,
          resourceBody: {
            // The first patch carries the guard; the batch makes the rest atomic with it.
            ...(at === 0 && guard !== undefined ? { condition: guard } : {}),
            operations: operations.slice(at, at + PATCH_OPERATIONS),
          },
        };
        chunks.push([operation, onFailure]);
      }
      return chunks;
    };
    const expiry = (expiresAt: number | null | undefined): PatchOperation[] => [
      { op: "set", path: "/expireAt", value: expiresAt ?? null },
      { op: "set", path: "/ttl", value: ttlOf(expiresAt) },
    ];
    /** A Create that fails on an item that exists, undone in the same batch. */
    const absent = (): (readonly [OperationInput, OnFailure])[] => [
      [
        { operationType: "Create", resourceBody: placeholderOf(op.key) },
        "fail",
      ],
      [{ operationType: "Delete", id }, "replan"],
    ];
    switch (op.type) {
      case "put": {
        const item = toItem(op.key, op.value, op.expiresAt);
        if (condition === undefined) {
          return [[{ operationType: "Upsert", resourceBody: item }, "replan"]];
        }
        if ("v" in condition) {
          return patches(
            [
              { op: "set", path: "/row", value: item.row },
              ...expiry(op.expiresAt),
            ],
            "fail",
          );
        }
        return [
          [
            condition.exists
              ? { operationType: "Replace", id, resourceBody: item }
              : { operationType: "Create", resourceBody: item },
            "fail",
          ],
        ];
      }
      case "delete":
        if (condition === undefined) {
          // Nothing to delete; an item a later write creates outlives this one.
          if (state === undefined) return [];
          return [[{ operationType: "Delete", id }, "replan"]];
        }
        if ("v" in condition) {
          if (state === undefined || state.v !== condition.v) {
            return { failed: true };
          }
          // The ETag holds the `_v` read; a write since, even a check,
          // replans. The service honors `ifMatch` on a batch Delete, which
          // the SDK's type leaves out.
          const operation = {
            operationType: "Delete",
            id,
            ifMatch: state.etag,
          } as OperationInput;
          return [[operation, "replan"]];
        }
        return condition.exists
          ? [[{ operationType: "Delete", id }, "fail"]]
          : absent();
      case "check":
        if (condition === undefined) return [];
        if ("v" in condition) {
          if (state === undefined || state.v !== condition.v) {
            return { failed: true };
          }
          // Patching restarts the item's TTL, so the guard rewrites the expiry it read.
          return patches(expiry(state.expireAt), "fail");
        }
        return condition.exists
          ? [[{ operationType: "Read", id }, "fail"]]
          : absent();
      case "add": {
        // An unguarded add creates the item it read missing.
        const creates =
          condition === undefined
            ? state === undefined
            : "exists" in condition && !condition.exists;
        if (creates) {
          const created: Record<string, unknown> = { ...op.init };
          for (const [name, delta] of Object.entries(op.by)) {
            created[name] = Number(created[name] ?? 0) + delta;
          }
          return [
            [
              {
                operationType: "Create",
                resourceBody: toItem(
                  op.key,
                  created as StoredRow,
                  op.expiresAt,
                ),
              },
              condition === undefined ? "replan" : "fail",
            ],
          ];
        }
        if (replaceWide && isWideAdd(op)) {
          // A missing item fails an `exists` or `_v` guard; the ETag holds
          // the row read, so a write since replans.
          if (state === undefined) return { failed: true };
          if (
            guard !== undefined &&
            state.v !== (condition as { v: unknown }).v
          ) {
            return { failed: true };
          }
          const row: Record<string, unknown> = { ...toRow(state.row) };
          for (const [name, delta] of Object.entries(op.by)) {
            row[name] = Number(row[name] ?? 0) + delta;
          }
          const operation = {
            operationType: "Replace",
            id,
            ifMatch: state.etag,
            resourceBody: toItem(
              op.key,
              row as StoredRow,
              op.expiresAt ?? state.expireAt ?? undefined,
            ),
          } as OperationInput;
          return [[operation, "replan"]];
        }
        // A patch of a missing item fails, which an `exists` guard needs.
        return patches(
          [
            ...Object.entries(op.by).map(
              ([name, delta]): PatchOperation => ({
                op: "incr",
                path: columnPath(name),
                value: delta,
              }),
            ),
            // An item from before its table's retention gains the expiry.
            ...(op.expiresAt === undefined ? [] : expiry(op.expiresAt)),
          ],
          condition === undefined ? "replan" : "fail",
        );
      }
    }
  };

  return {
    id: "cosmos",
    limits: COSMOS_LIMITS,
    async get(keys) {
      const found = new Map<string, StoredRow>();
      const ids = [...new Set(keys.map(cosmosItemId))];
      for (let at = 0; at < ids.length; at += GET_BATCH) {
        const { resources } = await (
          await container()
        ).items
          .query<{ id: string; row: unknown }>(
            `SELECT c.id, c.row FROM c WHERE c.id IN (${idList(ids.slice(at, at + GET_BATCH))})`,
            { partitionKey: COSMOS_PARTITION },
          )
          .fetchAll()
          .catch(missingContainer);
        for (const resource of resources) {
          found.set(resource.id, toRow(resource.row));
        }
      }
      return keys.map((key) => found.get(cosmosItemId(key)) ?? null);
    },
    async query({ pk, gte, lt, order, limit, after }) {
      const size = Math.min(limit, nativePageSize ?? limit);
      const filters = ["c.pk = @pk"];
      const parameters: { name: string; value: string | number }[] = [
        { name: "@pk", value: pk },
        { name: "@size", value: size },
      ];
      if (gte !== undefined) {
        filters.push("c.sk >= @gte");
        parameters.push({ name: "@gte", value: gte });
      }
      if (lt !== undefined) {
        filters.push("c.sk < @lt");
        parameters.push({ name: "@lt", value: lt });
      }
      if (after !== undefined) {
        filters.push(order === "asc" ? "c.sk > @after" : "c.sk < @after");
        parameters.push({ name: "@after", value: after });
      }
      const { resources } = await (
        await container()
      ).items
        .query<{ sk: string; row: unknown }>(
          {
            query: `SELECT TOP @size c.sk, c.row FROM c WHERE ${filters.join(
              " AND ",
            )} ORDER BY c.pk ${order === "asc" ? "ASC" : "DESC"}, c.sk ${
              order === "asc" ? "ASC" : "DESC"
            }`,
            parameters,
          },
          { partitionKey: COSMOS_PARTITION, maxItemCount: size },
        )
        .fetchAll()
        .catch(missingContainer);
      return {
        items: resources.map((resource) => ({
          sk: resource.sk,
          value: toRow(resource.row),
        })),
        more: resources.length === size,
      };
    },
    async write(ops) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const states = await readStates(
          [
            ...new Set(
              ops.filter(readsFirst).map((op) => cosmosItemId(op.key)),
            ),
          ],
          new Set(ops.filter(isWideAdd).map((op) => cosmosItemId(op.key))),
        );
        const plan = (replaceWide: boolean) => {
          const planned: Planned[] = [];
          for (const [position, op] of ops.entries()) {
            const operations = operationsOf(
              op,
              states.get(cosmosItemId(op.key)),
              replaceWide,
            );
            if ("failed" in operations) return { failedOp: position };
            for (const [operation, onFailure] of operations) {
              planned.push({ position, operation, onFailure });
            }
          }
          return planned;
        };
        // Patches send only the counters; replacing whole rows is the
        // fallback for wide adds whose patches take too many operations.
        let planned = plan(false);
        if ("failedOp" in planned) {
          return { ok: false, failedOp: planned.failedOp };
        }
        if (planned.length > BATCH_OPERATIONS) {
          const replaced = plan(true);
          if ("failedOp" in replaced) {
            return { ok: false, failedOp: replaced.failedOp };
          }
          planned = replaced;
          const bytes = encoder.encode(
            JSON.stringify(planned.map(({ operation }) => operation)),
          ).length;
          if (bytes > BATCH_BYTES) {
            throw new Error(
              `A Cosmos DB batch takes ${BATCH_BYTES} bytes; this write's rows of more counters than one patch takes need ${bytes}. Write fewer of them at once.`,
            );
          }
        }
        if (planned.length === 0) return { ok: true };
        if (planned.length > BATCH_OPERATIONS) {
          throw new Error(
            `A Cosmos DB batch takes ${BATCH_OPERATIONS} operations; this write needs ${planned.length}.`,
          );
        }
        let results: readonly { readonly statusCode: number }[];
        try {
          const response = await (
            await container()
          ).items.batch(
            planned.map(({ operation }) => operation),
            COSMOS_PARTITION,
          );
          if (response.result === undefined) {
            throw Object.assign(
              new Error(
                `Cosmos DB refused the batch with status ${response.code}`,
              ),
              { code: response.code },
            );
          }
          results = response.result;
        } catch (error) {
          if (emulatorAborted(error)) continue;
          if (TRANSIENT.has(statusOf(error) as number)) {
            return { ok: false, retry: true };
          }
          return missingContainer(error);
        }
        // The operation that failed; every other one reports 424.
        const failed = results.findIndex(
          ({ statusCode }) => statusCode >= 400 && statusCode !== 424,
        );
        if (failed === -1) return { ok: true };
        const status = results[failed]!.statusCode;
        const { position, onFailure } = planned[failed]!;
        if (TRANSIENT.has(status)) return { ok: false, retry: true };
        if (status !== 404 && status !== 409 && status !== 412) {
          throw new Error(
            `Cosmos DB refused a batch operation with status ${status}.`,
          );
        }
        if (onFailure === "fail") return { ok: false, failedOp: position };
      }
      return { ok: false, retry: true };
    },
    /** Plain deletes through the bulk API, where a missing item is no failure. */
    async deleteConsumed(keys) {
      let remaining = [...new Set(keys.map(cosmosItemId))];
      for (let attempt = 0; remaining.length > 0; attempt += 1) {
        const results = await (
          await container()
        ).items
          .executeBulkOperations(
            remaining.map(
              (id): OperationInput => ({
                operationType: "Delete",
                id,
                partitionKey: COSMOS_PARTITION,
              }),
            ),
          )
          .catch(missingContainer);
        const failed = results.flatMap((result, at) => {
          const status = result.response?.statusCode ?? statusOf(result.error);
          return (typeof status === "number" && status < 400) || status === 404
            ? []
            : [{ id: remaining[at]!, error: result.error, status }];
        });
        if (failed.length === 0) return;
        const retried = failed.filter(
          ({ error, status }) =>
            TRANSIENT.has(status as number) || emulatorAborted(error),
        );
        if (retried.length < failed.length || attempt >= 4) {
          throw new Error(
            `Cosmos DB refused to delete ${failed.length} consumed item(s) with status ${failed[0]!.status}.`,
          );
        }
        remaining = retried.map(({ id }) => id);
      }
    },
    migrations: {
      /** Creates the database and the container when they are missing. */
      async apply() {
        if (engine !== undefined) {
          await assertCosmosContainerReusable(await container(), engine);
        }
        const { database } = await (
          await open()
        ).client.databases.createIfNotExists({
          id: databaseId,
        });
        const { resource } = await database.containers.createIfNotExists({
          id: containerId,
          partitionKey: { paths: [COSMOS_PARTITION_KEY_PATH] },
          // Items carry their own TTL; -1 keeps the rest.
          defaultTtl: -1,
          indexingPolicy: COSMOS_INDEXING_POLICY,
        });
        if (resource === undefined) {
          throw new Error(`Cosmos DB returned no container ${containerId}.`);
        }
        assertContainerShape(resource);
        // An existing container keeps its own settings: every read is a
        // query, so it needs consistent, automatic indexing, the composite
        // index range reads order by, and a default TTL, without which
        // Cosmos DB ignores the items' own.
        const policy = resource.indexingPolicy;
        const indexed =
          (policy?.indexingMode ?? "consistent") === "consistent" &&
          policy?.automatic !== false;
        const composite = COSMOS_INDEXING_POLICY.compositeIndexes![0]!;
        const ordered = policy?.compositeIndexes?.some(
          (index) =>
            index.length === 2 &&
            index[0]!.path === "/pk" &&
            index[1]!.path === "/sk" &&
            (index[0]!.order ?? "ascending") ===
              (index[1]!.order ?? "ascending"),
        );
        const expires =
          resource.defaultTtl !== undefined && resource.defaultTtl !== null;
        if (!indexed || !ordered || !expires) {
          await database.container(containerId).replace({
            ...resource,
            defaultTtl: expires ? resource.defaultTtl : -1,
            indexingPolicy: {
              ...policy,
              indexingMode: "consistent",
              automatic: true,
              compositeIndexes: ordered
                ? policy?.compositeIndexes
                : [...(policy?.compositeIndexes ?? []), composite],
            },
          });
          await waitForIndexTransformation(database.container(containerId));
        }
      },
    },
    async dispose() {},
  };
};
