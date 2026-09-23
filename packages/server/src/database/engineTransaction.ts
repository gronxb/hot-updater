import {
  compareTuples,
  type DatabaseAdapter,
  type DatabaseKey,
  type DatabaseKeyValue,
  DATABASE_VERSION_COLUMN,
  indexEntries,
  type PhysicalTable,
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

/** The handle `fn` receives, by physical table name; `database()` types it per module. */
export interface TransactionEngine {
  findOne(
    table: string,
    lookup: Readonly<Record<string, DatabaseKeyValue>>,
  ): Promise<StoredRow | null>;
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isKeyed = (value: unknown): value is DatabaseKeyValue =>
  value !== null && value !== undefined;
const misuse = (table: string, message: string) =>
  new DatabaseTransactionError(`${table}: ${message}`);

interface Scope {
  run<T>(store: object, fn: () => T): T;
  getStore(): object | undefined;
}
const hooks = (
  globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
).process?.getBuiltinModule?.("node:async_hooks") as
  | { AsyncLocalStorage?: new () => Scope }
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

export const createTransactions = (options: {
  readonly adapter: DatabaseAdapter;
  readonly schema: ResolvedSchema;
  readonly reads: EngineReads;
  readonly retry?: RetryOptions;
}) => {
  const { adapter, schema, reads } = options;
  const {
    attempts = 8,
    baseDelayMs = 5,
    maxDelayMs = 250,
    onRetry,
  } = options.retry ?? {};
  const modelOf = (name: string, kind: "table" | "aggregate") => {
    const model = schema.models.get(name);
    if (model?.definition.kind !== kind) {
      throw new DatabaseQueryError(`Unknown ${kind} ${name}.`);
    }
    return model;
  };
  const tableOf = (name: string) => modelOf(name, "table");
  const depths = new Map<string, number>();
  /** Parents insert before children for adapters that keep foreign keys. */
  const depthOf = (model: ResolvedModel): number => {
    const { name } = model.table;
    if (!depths.has(name)) {
      depths.set(name, 0);
      const parents = model.references.filter(({ target }) => target !== name);
      depths.set(
        name,
        Math.max(
          0,
          ...parents.map(({ target }) => 1 + depthOf(tableOf(target))),
        ),
      );
    }
    return depths.get(name)!;
  };

  const attempt = async <R>(fn: (tx: TransactionEngine) => Promise<R>) => {
    const read = new Map<string, StoredRow | null>();
    /** Rows of rooted ranges: their root guards them, so they need no check of their own. */
    const ranged = new Map<string, StoredRow>();
    const writes = new Map<string, Pending>();
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
      const same =
        known === undefined ||
        (known && row ? versionOf(known) === versionOf(row) : known === row);
      if (!same) throw new StaleReadError();
      read.set(id, row);
      return row;
    };
    const readRow = (model: ResolvedModel, row: StoredRow) => {
      const id = idOf(model.table.name, rowKey(model.table, row));
      const known = read.get(id) ?? ranged.get(id);
      if (known && versionOf(known) === versionOf(row)) return known;
      throw misuse(
        model.table.name,
        "update and delete take a row this transaction read.",
      );
    };
    const checkFields = (
      model: ResolvedModel,
      values: Readonly<Row>,
      creating: boolean,
    ) => {
      const { fields } = model.definition;
      const bad = Object.keys(values).find(
        (field) =>
          !(field in fields) || (!creating && model.table.key.includes(field)),
      );
      if (bad !== undefined) {
        throw misuse(
          model.table.name,
          `${bad} cannot be ${creating ? "set" : "changed"}.`,
        );
      }
      for (const [field, { required }] of Object.entries(fields)) {
        if (
          required !== false &&
          (creating || field in values) &&
          !isKeyed(values[field])
        ) {
          throw misuse(model.table.name, `${field} is required.`);
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
      } else if (pending.type === "delete") {
        if (Object.values(by).some((delta) => delta > 0)) {
          throw new DatabaseConstraintError("not_found", model.table.name);
        }
      } else {
        for (const [column, delta] of Object.entries(by)) {
          pending.row[column] =
            Number(pending.row[column] ?? pending.read?.[column] ?? 0) + delta;
        }
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
        if (isKeyed(from)) bump(tableOf(target), [from], { [counter]: -1 });
        if (isKeyed(to)) bump(tableOf(target), [to], { [counter]: 1 });
      }
      for (const [index, root] of model.roots) {
        const parent = tableOf(root);
        const { eq } = model.table.indexes.find(({ name }) => name === index)!;
        for (const row of [before, after]) {
          const key = eq
            .slice(0, parent.table.key.length)
            .map((field) => row?.[field]);
          if (row && key.every(isKeyed)) bump(parent, key, {});
        }
      }
    };
    const derive = (model: ResolvedModel, row: Row): Row => {
      if (model.definition.kind === "table") {
        for (const [name, derived] of Object.entries(
          model.definition.derived,
        )) {
          row[name] = derived.compute(row as never);
        }
      }
      return row;
    };
    /** Deletes a row after its cascaded children, or refuses a restricted delete. */
    const remove = async (
      model: ResolvedModel,
      known: StoredRow,
    ): Promise<void> => {
      const { table } = model;
      const key = rowKey(table, known);
      const id = idOf(table.name, key);
      const pending = writes.get(id);
      if (pending?.type === "delete") return;
      if (pending && pending.type !== "increment") {
        throw misuse(table.name, "a transaction writes one key once.");
      }
      writes.set(id, { model, key, type: "delete", row: {}, read: known });
      touchParents(model, known, null);
      for (const reference of model.referencedBy) {
        const { counter, field } = reference;
        if (counter === undefined) continue;
        const stored = Number(known[counter] ?? 0);
        const added = Number(pending?.row[counter] ?? 0);
        if (added > 0)
          throw new DatabaseConstraintError("referenced", table.name);
        if (stored + added <= 0) continue;
        if (reference.onDelete === "restrict") {
          const [current] = await adapter.get(table, [key]);
          if (current && versionOf(current) === versionOf(known)) {
            throw new DatabaseConstraintError("referenced", table.name);
          }
          throw new StaleReadError();
        }
        const child = tableOf(reference.table);
        const index = child.table.indexes.find(
          ({ eq }) => eq.length === 1 && eq[0] === field,
        )!;
        let cursor: string | undefined;
        let seen = 0;
        do {
          const page = await reads.findMany(child.table.name, {
            index: index.name,
            where: { [field]: key[0]! },
            limit: Math.min(stored - seen, reads.maxPageSize),
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const row of page.rows) {
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
        const model = tableOf(name);
        const row = await reads.findOne(name, lookup);
        const byKey = model.table.key.every((field) => field in lookup);
        if (row === null && !byKey) return null;
        const key = row
          ? rowKey(model.table, row)
          : model.table.key.map((field) => lookup[field]!);
        return remember(model, key, row);
      }),
      findMany: step(async (name, input) => {
        const model = tableOf(name);
        const root = model.roots.get(input.index);
        if (root === undefined) {
          throw new DatabaseQueryError(
            `${name}.${input.index} is not rooted; a transaction reads a range only under a guarded parent.`,
          );
        }
        const parent = tableOf(root);
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
        const page = await reads.findMany(name, input);
        for (const row of page.rows) {
          ranged.set(idOf(name, rowKey(model.table, row)), row);
        }
        return page;
      }),
      create: step((name, values) => {
        const model = tableOf(name);
        checkFields(model, values, true);
        const defaults = [
          ...model.table.columns
            .filter(({ nullable }) => nullable)
            .map(({ name: column }) => [column, null] as const),
          ...model.referencedBy.flatMap(({ counter }) =>
            counter === undefined ? [] : [[counter, 0] as const],
          ),
        ];
        const row = derive(model, {
          ...Object.fromEntries(defaults),
          ...values,
          [DATABASE_VERSION_COLUMN]: 0,
        });
        const key = rowKey(model.table, row as StoredRow);
        const id = idOf(name, key);
        const pending = writes.get(id);
        if (pending && pending.type !== "increment") {
          throw misuse(name, "a transaction writes one key once.");
        }
        for (const [column, delta] of Object.entries(pending?.row ?? {})) {
          row[column] = Number(row[column]) + Number(delta);
        }
        writes.set(id, { model, key, type: "insert", row });
        touchParents(model, null, row);
      }),
      update: step((name, row, set) => {
        const model = tableOf(name);
        const known = readRow(model, row);
        checkFields(model, set, false);
        const key = rowKey(model.table, known);
        const id = idOf(name, key);
        const pending = writes.get(id);
        if (pending?.type === "insert" || pending?.type === "delete") {
          throw misuse(name, "a transaction writes one key once.");
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
        const model = tableOf(name);
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

  /** Parents insert first, then patches, increments, and checks, then children delete first. */
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
    const rank = (id: string) => {
      const { type, model } = writes.get(id)!;
      return type === "insert" ? depthOf(model) : Number.MAX_SAFE_INTEGER;
    };
    const checks = [...read].flatMap(([id, row]): WriteOp[] => {
      if (row === null || writes.has(id)) return [];
      const { table } = schema.models.get(JSON.parse(id)[0] as string)!;
      const guard = { v: versionOf(row) };
      return [{ type: "check", table, key: rowKey(table, row), guard }];
    });
    const ids = [...writes.keys()].filter(
      (id) => writes.get(id)!.type !== "delete",
    );
    return [
      ...ids.sort((left, right) => rank(left) - rank(right)).map(toOp),
      ...checks,
      ...deleted.map(toOp),
    ];
  };

  /** Whether another row holds one of `row`'s unique index entries. */
  const holdsUnique = async (
    table: PhysicalTable,
    key: DatabaseKey,
    row: StoredRow,
  ) => {
    for (const index of table.indexes) {
      if (!index.unique) continue;
      for (const eq of indexEntries(table, index, row)) {
        const rows = await adapter.query(table, {
          index: index.name,
          eq,
          order: "asc",
          limit: 2,
        });
        if (
          rows.some((other) => compareTuples(rowKey(table, other), key) !== 0)
        ) {
          return true;
        }
      }
    }
    return false;
  };

  /** Only a constraint the current state confirms is reported; anything else reruns. */
  const classify = async (
    op: WriteOp,
    read: Map<string, StoredRow | null>,
  ): Promise<ConstraintReason | undefined> => {
    if (op.type === "check" || op.type === "delete") return undefined;
    if (op.type === "increment" && op.guard) return undefined;
    const key = op.type === "insert" ? rowKey(op.table, op.row) : op.key;
    const [current] = await adapter.get(op.table, [key]);
    if (op.type === "increment") return current ? undefined : "not_found";
    if (op.type === "insert" && current) {
      const known = read.get(idOf(op.table.name, key));
      const stale =
        known === null ||
        (known !== undefined && versionOf(known) !== versionOf(current));
      return stale ? undefined : "exists";
    }
    if (
      op.type === "patch" &&
      current?.[DATABASE_VERSION_COLUMN] !== op.guard.v
    )
      return undefined;
    const row = op.type === "insert" ? op.row : { ...current!, ...op.set };
    return (await holdsUnique(op.table, key, row)) ? "unique" : undefined;
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
        if (delay > 0) await sleep(delay / 2 + Math.random() * (delay / 2));
        run ??= await attempt(fn).catch((error: unknown) => {
          if (error instanceof StaleReadError) return undefined;
          throw error;
        });
        if (run === undefined) {
          onRetry?.("rerun", round + 1);
          continue;
        }
        const { result, read } = run;
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
          return result;
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
        if (outcome.ok) return result;
        const failed = "failedOp" in outcome ? outcome.failedOp : undefined;
        if (failed === undefined || failed >= run.ops.length) {
          onRetry?.("resend", round + 1);
          continue;
        }
        const reason = await classify(ops[failed]!, read);
        if (reason)
          throw new DatabaseConstraintError(reason, ops[failed]!.table.name);
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
