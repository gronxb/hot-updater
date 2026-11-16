import {
  type DatabaseAdapter,
  DatabaseSchemaError,
  type DatabaseKey,
  type DatabaseKeyValue,
  DatabaseSnapshotConflictError,
  DatabaseSnapshotUnsupportedError,
  indexOrderColumns,
  normalizeStoredRow,
  type PhysicalIndex,
  type PhysicalTable,
  type QueryBound,
  type QueryRequest,
  type SnapshotReader,
  type StoredRow,
  type WriteOp,
  DATABASE_VERSION_COLUMN as V,
  findPhysicalColumn,
  findPhysicalIndex,
  rowKey,
} from "@hot-updater/plugin-core";
import {
  type ClientSession,
  type Document,
  type Filter,
  type IndexDescription,
  Long,
  MongoCompatibilityError,
  MongoError,
  MongoNetworkError,
  type MongoClient,
  type Timestamp,
} from "mongodb";

export interface MongoAdapterOptions {
  readonly client: MongoClient;
  /** Prepended to every collection name. */
  readonly tablePrefix?: string;
  /** The most ops one write accepts (default 1,000). */
  readonly maxOps?: number;
  /** Test-only: documents per native page. */
  readonly batchSize?: number;
}

export class MongoTransactionUnsupportedError extends Error {
  readonly name = "MongoTransactionUnsupportedError";
  constructor(cause: unknown) {
    super(
      "Hot Updater writes in MongoDB transactions, which need a replica set or a sharded cluster.",
      { cause },
    );
  }
}

type StoredId = DatabaseKeyValue | Readonly<Record<string, DatabaseKeyValue>>;

/** A single key column is the `_id`; a composite key is a document in key-column order. */
const idOf = (table: PhysicalTable, key: DatabaseKey): StoredId =>
  table.key.length === 1
    ? key[0]!
    : Object.fromEntries(table.key.map((column, at) => [column, key[at]]));

/** A filter on `_id` (never an ObjectId), and on the version when given. */
const byId = (
  _id: StoredId | { readonly $in: readonly StoredId[] },
  v?: number,
): Filter<Document> =>
  (v === undefined ? { _id } : { _id, [V]: v }) as unknown as Filter<Document>;

/** MongoDB's TTL monitor deletes a document once its `_expireAt` passes. */
const TTL = { name: "_expireAt", key: { _expireAt: 1 }, expireAfterSeconds: 0 };
/** When a row with retention expires; a null retention column never does. */
const expireAt = ({ retention }: PhysicalTable, row: StoredRow) => {
  const at = row[retention!.column];
  return typeof at === "number" ? new Date(at + retention!.ms) : null;
};

/** Null columns are left out, so unique indexes skip them as SQL's do. */
const toDocument = (table: PhysicalTable, row: StoredRow): Document => ({
  _id: idOf(table, rowKey(table, row)),
  ...Object.fromEntries(
    table.columns.flatMap(({ name }) =>
      row[name] === null || row[name] === undefined ? [] : [[name, row[name]]],
    ),
  ),
  ...(table.retention && { [TTL.name]: expireAt(table, row) }),
});

/** `columns op bound` over a tuple prefix, expanded into ORs. */
const compare = (
  columns: readonly string[],
  { values, inclusive }: QueryBound,
  op: "$gt" | "$lt",
): Document => {
  const terms = values.map((value, position) => ({
    ...Object.fromEntries(
      columns.slice(0, position).map((column, at) => [column, values[at]]),
    ),
    [columns[position]!]: {
      [position === values.length - 1 && inclusive ? `${op}e` : op]: value,
    },
  }));
  return terms.length === 1 ? terms[0]! : { $or: terms };
};

/**
 * The rows after `row` in MongoDB's sort order over `columns`. A null
 * column is missing from the document and sorts below every value, so a
 * null in an ascending read is followed by every value, and in a
 * descending read every value is followed by the nulls.
 */
const continuation = (
  columns: readonly string[],
  row: StoredRow,
  order: "asc" | "desc",
): Document => {
  const terms = columns.flatMap((column, position) => {
    const value = row[column] ?? null;
    const after =
      order === "asc"
        ? value === null
          ? { [column]: { $ne: null } }
          : { [column]: { $gt: value } }
        : value === null
          ? undefined
          : { $or: [{ [column]: { $lt: value } }, { [column]: null }] };
    if (after === undefined) return [];
    const equal = columns
      .slice(0, position)
      .map((before) => ({ [before]: row[before] ?? null }));
    return [equal.length === 0 ? after : { $and: [...equal, after] }];
  });
  // Key columns close every order, so a row always has a successor term.
  return { $or: terms };
};

const indexDescription = (
  table: PhysicalTable,
  index: PhysicalIndex,
): IndexDescription => {
  const ordered = BYTE_ORDERED.has(table.name);
  const columns = index.unique
    ? index.eq
    : [...index.eq, ...indexOrderColumns(table, index)];
  const exists = columns
    .filter((column) => findPhysicalColumn(table, column).nullable)
    .map((column) => [column, { $exists: true }]);
  return {
    name: index.name,
    key: Object.fromEntries(columns.map((column) => [column, 1])),
    ...(ordered && { collation: SIMPLE }),
    ...(index.unique && { unique: true }),
    ...(index.unique &&
      exists.length > 0 && {
        partialFilterExpression: Object.fromEntries(exists),
      }),
  };
};

/** Simple collation: strings compare and sort by their bytes. */
const SIMPLE = { locale: "simple" } as const;

/**
 * Core's tables whose reads walk string keys in byte order: their collection
 * and indexes are created with simple collation, every read names it, and
 * `db migrate` refuses an existing collection or index of another collation,
 * whose order and equality would differ from the keys' bytes.
 */
const BYTE_ORDERED = new Set(["release_catalog_partitions"]);

const mongoError = (error: unknown) =>
  error instanceof MongoError ? error : undefined;

/**
 * Every read goes to the primary, whatever the client's read preference: a
 * secondary can lag, and `get` and `query` promise every committed write.
 */
const PRIMARY = { readPreference: "primary" } as const;

/** How many times a snapshot read starts over after a transient failure. */
export const MONGO_SNAPSHOT_RESTARTS = 3;

/**
 * Failures a fresh snapshot can get past: the driver's retryable read codes
 * (elections, shutdowns, lost hosts) and network errors, plus SnapshotTooOld
 * (239), SnapshotUnavailable (246) and StaleChunkHistory (341), which a
 * snapshot older than the history the server keeps answers. A server
 * selection timeout is not one: the driver already waited out the election
 * for it, so the read fails rather than waiting again on each restart.
 */
const RESTARTABLE_CODES = new Set([
  6, 7, 89, 91, 134, 189, 239, 246, 262, 341, 9001, 10107, 11600, 11602, 13435,
  13436,
]);
const restartable = (error: unknown) =>
  error instanceof MongoNetworkError ||
  (error instanceof MongoError &&
    typeof error.code === "number" &&
    RESTARTABLE_CODES.has(error.code));

/**
 * A deployment that can't read at a snapshot: the driver refuses one before
 * 5.0 (wire version 13), and a standalone `mongod` answers NotAReplicaSet
 * (123).
 */
const unsupported = (error: unknown) =>
  error instanceof MongoCompatibilityError ||
  (error instanceof MongoError && error.code === 123);

/** A cursor id from a command reply: a number, or a Long past 2^53. */
const cursorOpen = (id: unknown) => String(id) !== "0";

/**
 * The storage engine's adapter over MongoDB: one collection per table, the
 * key as `_id`, and indexes as declared, with multi-valued fields as multikey
 * indexes. A write runs in one transaction. Guards are conditional updates,
 * and `check` is a conditional `$inc`: a real write, so a concurrent
 * transaction on the document conflicts.
 */
export const createMongoAdapter = (
  options: MongoAdapterOptions,
): DatabaseAdapter => {
  const { client, tablePrefix = "", maxOps = 1000 } = options;
  const collection = (table: PhysicalTable) =>
    client.db().collection(tablePrefix + table.name);
  const normalize = (table: PhysicalTable, document: Document) =>
    normalizeStoredRow(table, document, { jsonText: false });
  /** A read's collation: simple on a byte-ordered table, the collection's default elsewhere. */
  const collationOf = (table: PhysicalTable) =>
    BYTE_ORDERED.has(table.name) ? { collation: SIMPLE } : {};

  /** Refuses a byte-ordered table's collection or index with a collation other than simple. */
  const checkSimpleCollation = async (table: PhysicalTable) => {
    const name = tablePrefix + table.name;
    const [info] = await client
      .db()
      .listCollections({ name }, { nameOnly: false })
      .toArray();
    const options = (info as { options?: Document } | undefined)?.options;
    const differs = (collation: unknown) =>
      collation !== undefined &&
      (collation as { locale?: unknown }).locale !== "simple";
    if (differs(options?.collation)) {
      throw new DatabaseSchemaError(
        `MongoDB collection ${name} has collation ${JSON.stringify(options!.collation)}; Hot Updater reads its keys in byte order, which needs simple collation. Drop the collection and run db migrate again.`,
      );
    }
    for (const index of await collection(table).indexes()) {
      if (differs(index.collation)) {
        throw new DatabaseSchemaError(
          `MongoDB index ${index.name} on ${name} has collation ${JSON.stringify(index.collation)}; Hot Updater reads its keys in byte order, which needs simple collation. Drop the index and run db migrate again.`,
        );
      }
    }
  };

  /** A query's filter, after an optional exclusive cursor, and its sort. */
  const rangeOf = (table: PhysicalTable, request: QueryRequest) => {
    const index = findPhysicalIndex(table, request.index);
    const columns = indexOrderColumns(table, index);
    const filter = (after?: StoredRow): Filter<Document> => {
      const bounds = [
        ...(request.lower ? [compare(columns, request.lower, "$gt")] : []),
        ...(request.upper ? [compare(columns, request.upper, "$lt")] : []),
        ...(after ? [continuation(columns, after, request.order)] : []),
      ];
      return {
        ...Object.fromEntries(
          index.eq.map((column, at) => [column, request.eq[at]]),
        ),
        ...(bounds.length > 0 && { $and: bounds }),
      };
    };
    const direction = request.order === "asc" ? 1 : -1;
    const sort = Object.fromEntries(
      columns.map((column) => [column, direction]),
    ) as Record<string, 1 | -1>;
    return { filter, sort };
  };

  /**
   * One snapshot session's `find` commands. Each is a single bounded
   * command at the session's cluster time, never a `getMore`, whose
   * pinning to the snapshot the manual doesn't state. A reply cut short by
   * the 16 MiB batch limit leaves a cursor open, which is killed outside
   * the session (a snapshot session can't send `killCursors`) and read on
   * with a new `find`.
   */
  const snapshotRun = (session: ClientSession) => {
    const state: {
      failure?: unknown;
      unsupported?: DatabaseSnapshotUnsupportedError;
    } = {};
    // The cluster time the first reply chose. Until it is known, reads wait
    // for the first, so two concurrent first reads can't pick two snapshots.
    let chosen: Timestamp | undefined;
    let opening: Promise<void> | undefined;
    const find = async (
      table: PhysicalTable,
      filter: Document,
      limit: number,
      sort?: Document,
    ): Promise<{ documents: Document[]; more: boolean }> => {
      while (chosen === undefined && opening !== undefined) {
        await opening;
      }
      let opened: (() => void) | undefined;
      if (chosen === undefined) {
        opening = new Promise((resolve) => {
          opened = resolve;
        });
      }
      const name = tablePrefix + table.name;
      try {
        const reply = await client.db().command(
          {
            find: name,
            filter,
            ...(sort && { sort }),
            limit,
            batchSize: Math.min(limit, options.batchSize ?? limit),
            ...collationOf(table),
            // Explicit, though a raw command takes no client-level read
            // concern today: a reply without a cluster time fails anyway.
            readConcern: { level: "snapshot" },
          },
          { session, ...PRIMARY },
        );
        const { firstBatch, id, atClusterTime } = reply.cursor as {
          firstBatch: Document[];
          id: unknown;
          atClusterTime?: Timestamp;
        };
        if (atClusterTime === undefined) {
          throw new DatabaseSnapshotUnsupportedError(
            "MongoDB answered a snapshot read without its cluster time.",
          );
        }
        // The driver sends the session's time on every later read; a reply
        // at another time would mix two snapshots, so the read fails.
        chosen ??= atClusterTime;
        if (!chosen.equals(atClusterTime)) {
          throw new Error(
            "MongoDB answered a snapshot session's read at another cluster time.",
          );
        }
        const more = cursorOpen(id);
        if (more) {
          await client
            .db()
            .command(
              { killCursors: name, cursors: [Long.fromString(String(id))] },
              PRIMARY,
            )
            .catch(() => undefined);
          if (firstBatch.length === 0) {
            throw new Error(
              "MongoDB returned an empty batch of an open cursor.",
            );
          }
        }
        return { documents: firstBatch, more };
      } catch (error) {
        if (error instanceof DatabaseSnapshotUnsupportedError) {
          state.unsupported ??= error;
        } else if (unsupported(error)) {
          state.unsupported ??= new DatabaseSnapshotUnsupportedError(
            "This MongoDB deployment can't read at a snapshot, which needs MongoDB 5.0 or later on a replica set or a sharded cluster.",
            { cause: error },
          );
          throw state.unsupported;
        } else if (restartable(error)) {
          state.failure ??= error;
        }
        throw error;
      } finally {
        if (opened) {
          opening = undefined;
          opened();
        }
      }
    };
    return Object.assign(state, { find });
  };

  const snapshotReader = ({
    find,
  }: ReturnType<typeof snapshotRun>): SnapshotReader => ({
    async get(table, keys) {
      if (keys.length === 0) return [];
      const ids = keys.map((key) => idOf(table, key));
      const found = new Map<string, Document>();
      let pending = ids;
      for (;;) {
        const { documents, more } = await find(
          table,
          byId({ $in: pending }),
          pending.length,
        );
        for (const document of documents) {
          found.set(JSON.stringify(document._id), document);
        }
        if (!more) break;
        pending = pending.filter((id) => !found.has(JSON.stringify(id)));
      }
      return ids.map((id) => {
        const document = found.get(JSON.stringify(id));
        return document === undefined ? null : normalize(table, document);
      });
    },
    async query(table, request) {
      const { filter, sort } = rangeOf(table, request);
      const rows: StoredRow[] = [];
      for (;;) {
        const { documents, more } = await find(
          table,
          filter(rows.at(-1)),
          request.limit - rows.length,
          sort,
        );
        rows.push(...documents.map((document) => normalize(table, document)));
        if (!more || rows.length >= request.limit) return rows;
      }
    },
  });

  /** Whether the op applied; a guard that no longer matches changes nothing. */
  const apply = async (op: WriteOp, session: ClientSession) => {
    const target = collection(op.table);
    if (op.type === "insert") {
      await target.insertOne(toDocument(op.table, op.row), { session });
      return true;
    }
    const _id = idOf(op.table, op.key);
    const update = async (filter: Filter<Document>, change: Document) =>
      (await target.updateOne(filter, change, { session })).matchedCount === 1;
    switch (op.type) {
      case "patch": {
        const $set: Document = { [V]: op.guard.v + 1 };
        const $unset: Document = {};
        for (const [name, value] of Object.entries(op.set)) {
          if (value === null) $unset[name] = "";
          else $set[name] = value;
        }
        if (op.table.retention)
          $set[TTL.name] = expireAt(op.table, { ...op.previous, ...op.set });
        return update(byId(_id, op.guard.v), { $set, $unset });
      }
      case "delete":
        return (
          (await target.deleteOne(byId(_id, op.guard.v), { session }))
            .deletedCount === 1
        );
      case "check":
        // Written, never read: a concurrent transaction on the document conflicts.
        return update(byId(_id, op.guard.v), { $inc: { _checked: 1 } });
      case "increment": {
        if (op.init === undefined || op.guard !== undefined) {
          return update(byId(_id, op.guard?.v), {
            $inc: { ...op.by, [V]: 1 },
          });
        }
        // Creates the row from `init` when it is missing, in one upsert.
        const set: Document = {};
        for (const { name } of op.table.columns) {
          const start = op.init[name] ?? null;
          const by = name === V ? 1 : op.by[name];
          const stored = { $ifNull: [`$${name}`, { $literal: start ?? 0 }] };
          if (by !== undefined) set[name] = { $add: [stored, by] };
          else if (start !== null) set[name] = stored;
        }
        // A Date or null in a pipeline stage is a literal, not an expression.
        if (op.table.retention) set[TTL.name] = expireAt(op.table, op.init);
        await target.updateOne(byId(_id), [{ $set: set }], {
          upsert: true,
          session,
        });
        return true;
      }
    }
  };

  return {
    id: "mongodb",
    fits: (ops) => ops.length <= maxOps,

    async get(table, keys) {
      if (keys.length === 0) return [];
      const ids = keys.map((key) => idOf(table, key));
      const documents = await collection(table)
        .find(byId({ $in: ids }), { ...PRIMARY, ...collationOf(table) })
        .toArray();
      const found = new Map(
        documents.map((document) => [JSON.stringify(document._id), document]),
      );
      return ids.map((id) => {
        const document = found.get(JSON.stringify(id));
        return document === undefined ? null : normalize(table, document);
      });
    },

    async query(table, request) {
      const { filter, sort } = rangeOf(table, request);
      const documents = await collection(table)
        .find(filter(), {
          ...PRIMARY,
          sort,
          limit: request.limit,
          ...collationOf(table),
          ...(options.batchSize && { batchSize: options.batchSize }),
        })
        .toArray();
      return documents.map((document) => normalize(table, document));
    },

    /**
     * Reads in a snapshot session: every `find` carries read concern
     * `snapshot`, the first reply picks the cluster time, and the driver
     * sends it as `atClusterTime` on every later read. Nothing is checked
     * up front, so a deployment without snapshots serves every other call
     * as before, and only this call fails there.
     */
    async readSnapshot<T>(read: (reader: SnapshotReader) => Promise<T>) {
      for (let attempt = 0; ; attempt += 1) {
        const session = client.startSession({ snapshot: true });
        const run = snapshotRun(session);
        let result: { ok: true; value: T } | { ok: false; error: unknown };
        try {
          result = { ok: true, value: await read(snapshotReader(run)) };
        } catch (error) {
          result = { ok: false, error };
        } finally {
          await session.endSession().catch(() => undefined);
        }
        if (run.unsupported) throw run.unsupported;
        if (run.failure === undefined) {
          if (result.ok) return result.value;
          throw result.error;
        }
        // A read failed: whatever `read` made of it, the whole call starts
        // over on a fresh snapshot, so no answer mixes two snapshots.
        if (attempt === MONGO_SNAPSHOT_RESTARTS) {
          throw new DatabaseSnapshotConflictError(
            `MongoDB could not hold one snapshot for the read after ${attempt + 1} attempts.`,
            { cause: run.failure },
          );
        }
      }
    },

    async write(ops) {
      const session = client.startSession();
      let position = 0;
      try {
        session.startTransaction({
          readConcern: { level: "snapshot" },
          writeConcern: { w: "majority" },
        });
        for (; position < ops.length; position += 1) {
          if (!(await apply(ops[position]!, session))) {
            await session.abortTransaction();
            return { ok: false, failedOp: position };
          }
        }
        // Committing again is safe when the outcome is unknown.
        await session.commitTransaction().catch(async (error: unknown) => {
          const unknown = mongoError(error)?.hasErrorLabel(
            "UnknownTransactionCommitResult",
          );
          if (!unknown) throw error;
          await session.commitTransaction();
        });
        return { ok: true };
      } catch (error) {
        if (session.inTransaction()) {
          await session.abortTransaction().catch(() => undefined);
        }
        const failure = mongoError(error);
        if (
          failure?.hasErrorLabel("TransientTransactionError") ||
          failure?.code === 112
        ) {
          return { ok: false, retry: true };
        }
        if (failure?.code === 11000 && position < ops.length) {
          // Two upserts creating one key race; the loser runs again.
          return ops[position]!.type === "increment"
            ? { ok: false, retry: true }
            : { ok: false, failedOp: position };
        }
        throw failure?.code === 20
          ? new MongoTransactionUnsupportedError(error)
          : error;
      } finally {
        await session.endSession();
      }
    },

    migrations: {
      async apply(tables) {
        for (const table of tables) {
          // An existing collection keeps its documents; its indexes are ensured.
          const ordered = BYTE_ORDERED.has(table.name);
          await client
            .db()
            .createCollection(
              tablePrefix + table.name,
              ordered ? { collation: SIMPLE } : {},
            )
            .catch((error: unknown) => {
              if (mongoError(error)?.code !== 48) throw error;
            });
          if (ordered) await checkSimpleCollation(table);
          if (table.retention) await collection(table).createIndexes([TTL]);
          // MongoDB refuses a second index over the same keys, and a query
          // reads through the first, as `releases.scopes` through `byScope`.
          const indexes = new Map<string, IndexDescription>();
          for (const index of table.indexes) {
            const description = indexDescription(table, index);
            const keys = JSON.stringify([description.key, description.unique]);
            if (!indexes.has(keys)) indexes.set(keys, description);
          }
          if (indexes.size === 0) continue;
          await collection(table).createIndexes([...indexes.values()]);
        }
      },
    },
  };
};
