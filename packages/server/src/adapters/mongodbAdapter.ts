import {
  type DatabaseAdapter,
  type DatabaseKey,
  DATABASE_VERSION_COLUMN as V,
  findPhysicalColumn,
  findPhysicalIndex,
  indexOrderColumns,
  normalizeStoredRow,
  type PhysicalIndex,
  type PhysicalTable,
  type QueryBound,
  rowKey,
  type StoredRow,
  type WriteOp,
} from "@hot-updater/plugin-core/internal";
import {
  type ClientSession,
  type Document,
  type Filter,
  type IndexDescription,
  MongoError,
  type MongoClient,
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

type StoredId =
  | DatabaseKey[number]
  | Readonly<Record<string, DatabaseKey[number]>>;

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

/** Null columns are left out, so unique indexes skip them as SQL's do. */
const toDocument = (table: PhysicalTable, row: StoredRow): Document => ({
  _id: idOf(table, rowKey(table, row)),
  ...Object.fromEntries(
    table.columns.flatMap(({ name }) =>
      row[name] === null || row[name] === undefined ? [] : [[name, row[name]]],
    ),
  ),
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

const indexDescription = (
  table: PhysicalTable,
  index: PhysicalIndex,
): IndexDescription => {
  const columns = index.unique
    ? index.eq
    : [...index.eq, ...indexOrderColumns(table, index)];
  const nullable = columns.filter(
    (column) => findPhysicalColumn(table, column).nullable,
  );
  const exists = nullable.map((column) => [column, { $exists: true }]);
  return {
    name: index.name,
    key: Object.fromEntries(columns.map((column) => [column, 1])),
    ...(index.unique && { unique: true }),
    ...(index.unique &&
      exists.length > 0 && {
        partialFilterExpression: Object.fromEntries(exists),
      }),
  };
};

const mongoError = (error: unknown) =>
  error instanceof MongoError ? error : undefined;

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
        const entries = Object.entries(op.set);
        const unset = entries.filter(([, value]) => value === null);
        return update(byId(_id, op.guard.v), {
          $set: {
            ...Object.fromEntries(
              entries.filter(([, value]) => value !== null),
            ),
            [V]: op.guard.v + 1,
          },
          $unset: Object.fromEntries(unset.map(([key]) => [key, ""])),
        });
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
        .find(byId({ $in: ids }))
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
      const index = findPhysicalIndex(table, request.index);
      const columns = indexOrderColumns(table, index);
      const bounds = [
        ...(request.lower ? [compare(columns, request.lower, "$gt")] : []),
        ...(request.upper ? [compare(columns, request.upper, "$lt")] : []),
      ];
      const direction = request.order === "asc" ? 1 : -1;
      const documents = await collection(table)
        .find(
          {
            ...Object.fromEntries(
              index.eq.map((column, at) => [column, request.eq[at]]),
            ),
            ...(bounds.length > 0 && { $and: bounds }),
          },
          {
            sort: Object.fromEntries(
              columns.map((column) => [column, direction]),
            ),
            limit: request.limit,
            ...(options.batchSize && { batchSize: options.batchSize }),
          },
        )
        .toArray();
      return documents.map((document) => normalize(table, document));
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
        if (failure?.code === 20) {
          throw new MongoTransactionUnsupportedError(error);
        }
        throw error;
      } finally {
        await session.endSession();
      }
    },

    migrations: {
      async apply(tables) {
        for (const table of tables) {
          // An existing collection keeps its documents; its indexes are ensured.
          await client
            .db()
            .createCollection(tablePrefix + table.name)
            .catch((error: unknown) => {
              if (mongoError(error)?.code !== 48) throw error;
            });
          if (table.indexes.length === 0) continue;
          await collection(table).createIndexes(
            table.indexes.map((index) => indexDescription(table, index)),
          );
        }
      },
    },
  };
};
