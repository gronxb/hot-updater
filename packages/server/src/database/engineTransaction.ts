import {
  canonicalJson,
  compareTuples,
  type DatabaseAdapter,
  type DatabaseKey,
  type DatabaseKeyValue,
  DATABASE_VERSION_COLUMN,
  indexEntries,
  rowKey,
  type StoredRow,
  type WriteOp,
  type WriteResult,
} from "@hot-updater/plugin-core/internal";

import {
  type AggregateChange,
  compileAggregates,
  NegativeGaugeError,
  recordAggregate,
} from "./engineAggregates";
import {
  DatabaseQueryError,
  type EngineReads,
  type Page,
  type ReadInput,
} from "./engineReads";
import {
  type ConstraintReason,
  DatabaseAmbiguousCommitError,
  DatabaseConflictError,
  DatabaseConstraintError,
  DatabaseTransactionError,
} from "./errors";
import type { ResolvedModel, ResolvedSchema } from "./resolveSchema";

/** A row this attempt read changed while it ran; the attempt reruns. */
class StaleReadError extends Error {}

export interface RetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Called before each rerun of `fn` and each resend of the same write, with the attempt that failed (from 1). */
  readonly onRetry?: (kind: "rerun" | "resend", attempt: number) => void;
}

type Row = Record<string, unknown>;
type Lookup = Readonly<Record<string, DatabaseKeyValue>>;

/** The handle `fn` receives, by physical table name; `database()` types it per module. */
export interface TransactionEngine {
  findOne(table: string, lookup: Lookup): Promise<StoredRow | null>;
  findMany(table: string, input: ReadInput): Promise<Page<StoredRow>>;
  create(table: string, row: Readonly<Row>): void;
  update(table: string, row: StoredRow, set: Readonly<Row>): void;
  delete(table: string, row: StoredRow): Promise<void>;
  aggregate(
    table: string,
    identity: Readonly<Row>,
    values: Readonly<Row>,
    options?: { readonly shardBy?: string },
  ): void;
}

/** The one pending op on a key: `row` holds the inserted row, patched columns, or increments. */
interface Pending {
  readonly model: ResolvedModel;
  readonly key: DatabaseKey;
  readonly type: "insert" | "patch" | "delete" | "increment";
  readonly row: Row;
  /** The row a patch or delete replaces. */
  readonly read?: StoredRow;
}

const idOf = (table: string, key: DatabaseKey) => JSON.stringify([table, key]);
const versionOf = (row: StoredRow) => Number(row[DATABASE_VERSION_COLUMN]);
const isKeyed = (value: unknown): value is DatabaseKeyValue =>
  value !== null && value !== undefined;
const misuse = (table: string, message: string) =>
  new DatabaseTransactionError(`${table}: ${message}`);
const once = (table: string) =>
  misuse(table, "a transaction writes one key once.");

const hooks = (
  globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
).process?.getBuiltinModule?.("node:async_hooks") as
  | {
      AsyncLocalStorage?: new () => {
        run<T>(store: object, fn: () => T): T;
        getStore(): object | undefined;
      };
    }
  | undefined;
/** Where the runtime tracks async context, `db.*` inside a transaction throws. */
const transactionScope = hooks?.AsyncLocalStorage
  ? new hooks.AsyncLocalStorage()
  : undefined;

export const assertOutsideTransaction = (): void => {
  if (transactionScope?.getStore() !== undefined) {
    throw new DatabaseTransactionError(
      "Inside transaction(), read and write through its handle; db and core are not part of it.",
    );
  }
};

export const createTransactions = ({
  adapter,
  schema,
  reads,
  retry = {},
}: {
  readonly adapter: DatabaseAdapter;
  readonly schema: ResolvedSchema;
  readonly reads: EngineReads;
  readonly retry?: RetryOptions;
}) => {
  const { attempts = 8, baseDelayMs = 5, maxDelayMs = 250, onRetry } = retry;
  const modelOf = (name: string, kind: "table" | "aggregate" = "table") => {
    const model = schema.models.get(name);
    if (model?.definition.kind !== kind) {
      throw new DatabaseQueryError(`Unknown ${kind} ${name}.`);
    }
    return model;
  };

  /**
   * A key-value index copy has no `_v`. A transaction guards what it reads,
   * so it reads such a row whole, and reruns if it changed since the copy.
   */
  const complete = async (
    { table }: ResolvedModel,
    rows: readonly StoredRow[],
  ): Promise<StoredRow[]> => {
    const copies = rows.filter((row) => !(DATABASE_VERSION_COLUMN in row));
    if (copies.length === 0) return [...rows];
    const current = await adapter.get(
      table,
      copies.map((copy) => rowKey(table, copy)),
    );
    return rows.map((row) => {
      const at = copies.indexOf(row);
      if (at < 0) return row;
      const whole = current[at];
      if (
        !whole ||
        Object.keys(row).some(
          (column) =>
            canonicalJson(row[column]) !== canonicalJson(whole[column]),
        )
      ) {
        throw new StaleReadError();
      }
      return whole;
    });
  };

  const attempt = async <R>(fn: (tx: TransactionEngine) => Promise<R>) => {
    const read = new Map<string, StoredRow | null>();
    /** Rows of rooted ranges: their root guards them, so they need no check of their own. */
    const ranged = new Map<string, StoredRow>();
    const writes = new Map<string, Pending>();
    /** Deleted keys, children before their parents. */
    const deleted: string[] = [];
    const aggregates = new Map<string, AggregateChange>();
    let open = true;
    let failure: { readonly error: unknown } | undefined;
    /** A failed call fails the attempt even when `fn` catches it. */
    const step =
      <A extends unknown[], T>(method: (...args: A) => T) =>
      (...args: A): T => {
        if (!open) {
          throw new DatabaseTransactionError("The transaction has ended.");
        }
        const fail = (error: unknown): never => {
          failure ??= { error };
          throw error;
        };
        try {
          const result = method(...args);
          return (result instanceof Promise ? result.catch(fail) : result) as T;
        } catch (error) {
          return fail(error);
        }
      };
    const remember = (
      model: ResolvedModel,
      key: DatabaseKey,
      row: StoredRow | null,
    ) => {
      const id = idOf(model.table.name, key);
      const known = read.get(id);
      if (
        known !== undefined &&
        (known && row ? versionOf(known) !== versionOf(row) : known !== row)
      ) {
        throw new StaleReadError();
      }
      read.set(id, row);
      return row;
    };
    const readRow = ({ table }: ResolvedModel, row: StoredRow) => {
      const id = idOf(table.name, rowKey(table, row));
      const known = read.get(id) ?? ranged.get(id);
      if (known && versionOf(known) === versionOf(row)) return known;
      throw misuse(
        table.name,
        "update and delete take a row this transaction read.",
      );
    };
    const checkFields = (
      { table, definition: { fields } }: ResolvedModel,
      values: Readonly<Row>,
      creating: boolean,
    ) => {
      for (const field of Object.keys(values)) {
        if (!(field in fields) || (!creating && table.key.includes(field))) {
          throw misuse(
            table.name,
            `${field} cannot be ${creating ? "set" : "changed"}.`,
          );
        }
      }
      for (const [field, { required }] of Object.entries(fields)) {
        if (
          required !== false &&
          (creating || field in values) &&
          !isKeyed(values[field])
        ) {
          throw misuse(table.name, `${field} is required.`);
        }
      }
    };
    /** Adds counter deltas to a key's pending op; an empty `by` still bumps `_v`. */
    const bump = (
      model: ResolvedModel,
      key: DatabaseKey,
      by: Readonly<Record<string, number>>,
    ) => {
      const id = idOf(model.table.name, key);
      const pending = writes.get(id);
      if (pending === undefined) {
        writes.set(id, { model, key, type: "increment", row: { ...by } });
      } else if (pending.type !== "delete") {
        for (const [column, delta] of Object.entries(by)) {
          pending.row[column] =
            Number(pending.row[column] ?? pending.read?.[column] ?? 0) + delta;
        }
      } else if (Object.values(by).some((delta) => delta > 0)) {
        throw new DatabaseConstraintError("not_found", model.table.name);
      }
    };
    /** Moves parent counters when a reference changes and bumps every rooted parent. */
    const touchParents = (
      model: ResolvedModel,
      before: Row | null,
      after: Row | null,
    ) => {
      for (const { field, counter, target } of model.references) {
        const [from, to] = [before?.[field], after?.[field]];
        if (counter === undefined || from === to) continue;
        if (isKeyed(from)) bump(modelOf(target), [from], { [counter]: -1 });
        if (isKeyed(to)) bump(modelOf(target), [to], { [counter]: 1 });
      }
      for (const [index, root] of model.roots) {
        const parent = modelOf(root);
        const { eq } = model.table.indexes.find(({ name }) => name === index)!;
        for (const row of [before, after]) {
          const key = eq
            .slice(0, parent.table.key.length)
            .map((field) => row?.[field]);
          if (row && key.every(isKeyed)) bump(parent, key, {});
        }
      }
    };
    const derive = ({ definition }: ResolvedModel, row: Row): Row => {
      if (definition.kind === "table") {
        for (const [name, derived] of Object.entries(definition.derived)) {
          row[name] = derived.compute(row as never);
        }
      }
      return row;
    };
    /** Deletes a row after its cascaded children, or refuses a restricted delete. */
    const remove = async (model: ResolvedModel, known: StoredRow) => {
      const { table } = model;
      const key = rowKey(table, known);
      const id = idOf(table.name, key);
      const pending = writes.get(id);
      if (pending?.type === "delete") return;
      if (pending && pending.type !== "increment") throw once(table.name);
      writes.set(id, { model, key, type: "delete", row: {}, read: known });
      touchParents(model, known, null);
      for (const {
        counter,
        field,
        onDelete,
        table: name,
      } of model.referencedBy) {
        if (counter === undefined) continue;
        const stored = Number(known[counter] ?? 0);
        const added = Number(pending?.row[counter] ?? 0);
        if (added > 0)
          throw new DatabaseConstraintError("referenced", table.name);
        if (stored + added <= 0) continue;
        if (onDelete === "restrict") {
          const [current] = await adapter.get(table, [key]);
          if (current && versionOf(current) === versionOf(known)) {
            throw new DatabaseConstraintError("referenced", table.name);
          }
          throw new StaleReadError();
        }
        const child = modelOf(name);
        const index = child.table.indexes.find(
          ({ eq }) => eq.length === 1 && eq[0] === field,
        )!;
        let cursor: string | undefined;
        let seen = 0;
        do {
          const page = await reads.findMany(name, {
            index: index.name,
            where: { [field]: key[0]! },
            limit: Math.min(stored - seen, reads.maxPageSize),
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const row of await complete(child, page.rows)) {
            await remove(
              child,
              remember(child, rowKey(child.table, row), row)!,
            );
          }
          seen += page.rows.length;
          cursor = page.next;
        } while (cursor !== undefined && seen < stored);
      }
      deleted.push(id);
    };

    const tx: TransactionEngine = {
      findOne: step(async (name, lookup) => {
        const model = modelOf(name);
        const { table } = model;
        const found = await reads.findOne(name, lookup);
        if (found === null && !table.key.every((field) => field in lookup)) {
          return null;
        }
        const [row = null] = found ? await complete(model, [found]) : [];
        const key = row
          ? rowKey(table, row)
          : table.key.map((field) => lookup[field]!);
        return remember(model, key, row);
      }),
      findMany: step(async (name, input) => {
        const model = modelOf(name);
        const root = model.roots.get(input.index);
        if (root === undefined) {
          throw new DatabaseQueryError(
            `${name}.${input.index} is not rooted; a transaction reads a range only under a guarded parent.`,
          );
        }
        const parent = modelOf(root);
        const { eq } = model.table.indexes.find(
          ({ name: index }) => index === input.index,
        )!;
        const key = parent.table.key.map(
          (_, position) => input.where?.[eq[position]!] as DatabaseKeyValue,
        );
        const lookup = Object.fromEntries(
          parent.table.key.map((field, position) => [field, key[position]!]),
        );
        remember(parent, key, await reads.findOne(root, lookup));
        const found = await reads.findMany(name, input);
        const rows = await complete(model, found.rows);
        for (const row of rows) {
          ranged.set(idOf(name, rowKey(model.table, row)), row);
        }
        return { ...found, rows };
      }),
      create: step((name, values) => {
        const model = modelOf(name);
        checkFields(model, values, true);
        const row = derive(model, {
          ...Object.fromEntries(
            model.table.columns.flatMap(({ name: column, nullable }) =>
              nullable ? [[column, null]] : [],
            ),
          ),
          ...Object.fromEntries(
            model.referencedBy.flatMap(({ counter }) =>
              counter === undefined ? [] : [[counter, 0]],
            ),
          ),
          ...values,
          [DATABASE_VERSION_COLUMN]: 0,
        });
        const key = rowKey(model.table, row as StoredRow);
        const id = idOf(name, key);
        const pending = writes.get(id);
        if (pending && pending.type !== "increment") throw once(name);
        for (const [column, delta] of Object.entries(pending?.row ?? {})) {
          row[column] = Number(row[column]) + Number(delta);
        }
        writes.set(id, { model, key, type: "insert", row });
        touchParents(model, null, row);
      }),
      update: step((name, row, set) => {
        const model = modelOf(name);
        const known = readRow(model, row);
        checkFields(model, set, false);
        const key = rowKey(model.table, known);
        const id = idOf(name, key);
        const pending = writes.get(id);
        if (pending?.type === "insert" || pending?.type === "delete") {
          throw once(name);
        }
        const before =
          pending?.type === "patch" ? { ...known, ...pending.row } : known;
        const next = derive(model, { ...before, ...set });
        const changed = Object.entries(next).filter(
          ([column, value]) =>
            column !== DATABASE_VERSION_COLUMN &&
            JSON.stringify(value) !== JSON.stringify(known[column]),
        );
        writes.set(id, {
          model,
          key,
          type: "patch",
          row: Object.fromEntries(changed),
          read: known,
        });
        if (pending?.type === "increment") {
          bump(model, key, pending.row as Record<string, number>);
        }
        touchParents(model, before, next);
      }),
      delete: step(async (name, row) => {
        const model = modelOf(name);
        await remove(model, readRow(model, row));
      }),
      aggregate: step((name, identity, values, options) => {
        const model = modelOf(name, "aggregate");
        recordAggregate(aggregates, model, identity, values, options?.shardBy);
      }),
    };

    try {
      const result = await (transactionScope
        ? transactionScope.run(tx, () => fn(tx))
        : fn(tx));
      if (failure) throw failure.error;
      const ops = compile(writes, read, deleted);
      return { result, read, ops, aggregates: [...aggregates.values()] };
    } catch (error) {
      throw failure?.error instanceof StaleReadError ? failure.error : error;
    } finally {
      open = false;
    }
  };

  /** Deletes first, children before parents, so a freed unique value can be reused; then the other writes, then checks. */
  const compile = (
    writes: Map<string, Pending>,
    read: Map<string, StoredRow | null>,
    deleted: readonly string[],
  ): WriteOp[] => {
    const toOp = (id: string): WriteOp => {
      const { model, key, type, row, read: previous } = writes.get(id)!;
      const { table } = model;
      if (type === "insert") return { type, table, row: row as StoredRow };
      if (type === "increment") {
        const known = read.get(id);
        const by = row as Record<string, number>;
        return known
          ? { type, table, key, by, guard: { v: versionOf(known) } }
          : { type, table, key, by };
      }
      const guard = { v: versionOf(previous!) };
      return type === "patch"
        ? {
            type,
            table,
            key,
            set: row as StoredRow,
            guard,
            previous: previous!,
          }
        : { type, table, key, guard, previous: previous! };
    };
    const checks = [...read].flatMap(([id, row]): WriteOp[] => {
      if (row === null || writes.has(id)) return [];
      const { table } = schema.models.get(JSON.parse(id)[0] as string)!;
      const guard = { v: versionOf(row) };
      return [{ type: "check", table, key: rowKey(table, row), guard }];
    });
    const rest = [...writes.keys()].filter(
      (id) => writes.get(id)!.type !== "delete",
    );
    return [...deleted.map(toOp), ...rest.map(toOp), ...checks];
  };

  /** Only a constraint the current state confirms is reported; anything else reruns. */
  const classify = async (
    op: WriteOp,
    read: Map<string, StoredRow | null>,
  ): Promise<ConstraintReason | undefined> => {
    if (op.type === "check" || op.type === "delete") return undefined;
    if (op.type === "increment" && op.guard) return undefined;
    const { table } = op;
    const key = op.type === "insert" ? rowKey(table, op.row) : op.key;
    const [current] = await adapter.get(table, [key]);
    if (op.type === "increment") return current ? undefined : "not_found";
    if (op.type === "insert" && current) {
      const known = read.get(idOf(table.name, key));
      const stale =
        known === null ||
        (known !== undefined && versionOf(known) !== versionOf(current));
      return stale ? undefined : "exists";
    }
    if (
      op.type === "patch" &&
      current?.[DATABASE_VERSION_COLUMN] !== op.guard.v
    ) {
      return undefined;
    }
    // Whether another row holds one of the row's unique index entries.
    const row = op.type === "insert" ? op.row : { ...current!, ...op.set };
    for (const index of table.indexes) {
      if (!index.unique) continue;
      for (const eq of indexEntries(table, index, row)) {
        const rows = await adapter.query(table, {
          index: index.name,
          eq,
          order: "asc",
          limit: 2,
        });
        if (rows.some((other) => compareTuples(rowKey(table, other), key))) {
          return "unique";
        }
      }
    }
    return undefined;
  };

  return {
    async transaction<R>(
      fn: (tx: TransactionEngine) => Promise<R>,
    ): Promise<R> {
      assertOutsideTransaction();
      let run: Awaited<ReturnType<typeof attempt<R>>> | undefined;
      let negative: NegativeGaugeError | undefined;
      for (let round = 0; round < attempts; round += 1) {
        const delay =
          round && Math.min(maxDelayMs, baseDelayMs * 2 ** (round - 1));
        if (delay > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, delay / 2 + Math.random() * (delay / 2)),
          );
        }
        run ??= await attempt(fn).catch((error: unknown) => {
          if (error instanceof StaleReadError) return undefined;
          throw error;
        });
        if (run === undefined) {
          onRetry?.("rerun", round + 1);
          continue;
        }
        let aggregates: WriteOp[];
        try {
          aggregates = await compileAggregates(adapter, run.aggregates);
        } catch (error) {
          // Deltas from a row another writer has since moved: rerun and read it again.
          if (!(error instanceof NegativeGaugeError)) throw error;
          negative = error;
          onRetry?.("rerun", round + 1);
          run = undefined;
          continue;
        }
        const ops = [...run.ops, ...aggregates];
        if (ops.length <= 1 && ops.every(({ type }) => type === "check")) {
          return run.result;
        }
        if (!adapter.fits(ops)) {
          throw new DatabaseConstraintError("too_large", ops[0]!.table.name);
        }
        let outcome: WriteResult;
        try {
          outcome = await adapter.write(ops);
        } catch (cause) {
          throw new DatabaseAmbiguousCommitError(
            "The commit outcome is unknown.",
            { cause },
          );
        }
        if (outcome.ok) return run.result;
        const failed = "failedOp" in outcome ? outcome.failedOp : undefined;
        if (failed === undefined || failed >= run.ops.length) {
          onRetry?.("resend", round + 1);
          continue;
        }
        const reason = await classify(ops[failed]!, run.read);
        if (reason) {
          throw new DatabaseConstraintError(reason, ops[failed]!.table.name);
        }
        onRetry?.("rerun", round + 1);
        run = undefined;
      }
      throw (
        negative ??
        new DatabaseConflictError(
          `The transaction conflicted ${attempts} times.`,
        )
      );
    },
  };
};
