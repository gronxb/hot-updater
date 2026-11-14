import {
  type DatabaseAdapter,
  type DatabaseKey,
  DATABASE_VERSION_COLUMN,
  type StoredRow,
  type WriteOp,
} from "../../database/adapter";
import { compareUtf8 } from "../../database/values";
import type { AggregateBatching } from "../../types/databaseConfig";
import type { AggregateShape } from "./definitions";
import type { StorageEngine } from "./engine";
import { type AggregateChange, recordAggregate } from "./engineAggregates";
import type { TransactionEngine } from "./engineTransaction";
import { DatabaseTransactionError } from "./errors";
import type {
  ResolvedModel,
  ResolvedSchema,
  SchemaModule,
} from "./resolveSchema";
import { defineTable } from "./schema";

/** Log rows spread over 8 tables, each its own DynamoDB partition. */
const LOG_TABLES = [0, 1, 2, 3, 4, 5, 6, 7].map((at) => `aggregate_log_${at}`);
const LEASE_TABLE = "aggregate_lease";
const LEASE = { id: "compaction" } as const;
/** How long a compaction holds the lease before another process may take it. */
const LEASE_MS = 30_000;
/** A commit compacts once this has passed since the last compaction. */
const WINDOW_MS = 60_000;
/** Log rows a compaction reads from each log table for one group. */
const LOG_PAGE = 200;
/**
 * How old a log row this process can't apply must be before its reads step
 * past it: older than any transaction still committing, between servers
 * whose clocks agree this closely.
 */
const SKIP_AFTER_MS = 300_000;
/**
 * Groups one compaction applies: after a commit, so the request that runs
 * it waits for one group; before a read; and on flush.
 */
const GROUPS = { commit: 1, read: 8, flush: 256 } as const;
/** Tries per write after a conflict or a transient error. */
const ATTEMPTS = 5;

const log = defineTable(
  {
    id: { type: "string", maxLength: 32 },
    /** One committed transaction's changes, one entry per aggregate row. */
    changes: { type: "string" },
  },
  { key: ["id"], indexes: { oldest: { eq: [], sort: ["id"] } } },
);

/**
 * Held by `holder` until `until`; the next compaction is due at `next`.
 * `applied` lists the log rows a compaction has applied and not yet deleted,
 * as `[log table's index, id]` pairs, so no compaction applies them again.
 */
const lease = defineTable(
  {
    id: { type: "string", maxLength: 16 },
    holder: { type: "string", maxLength: 32 },
    until: { type: "integer" },
    next: { type: "integer" },
    applied: { type: "string" },
  },
  { key: ["id"] },
);

/** The log and lease tables; an engine that batches has them in its schema. */
export const aggregateBatchingModule: SchemaModule = {
  id: "aggregateBatching",
  schema: {
    ...Object.fromEntries(LOG_TABLES.map((table) => [table, log])),
    [LEASE_TABLE]: lease,
  },
};

type Changes = Map<string, AggregateChange>;
type Values = Readonly<Record<string, unknown>>;

const shapeOf = (model: ResolvedModel) =>
  model.definition as AggregateShape & { readonly batched?: true };

const isBatched = (model: ResolvedModel | undefined): model is ResolvedModel =>
  model?.definition.kind === "aggregate" && shapeOf(model).batched === true;

const valuesOf = ({ deltas, sketches }: AggregateChange): Values => ({
  ...deltas,
  ...sketches,
});

/**
 * Merges `values` into the change for `key`'s identity as `tx.aggregate`
 * does: deltas add up and sketches merge. One constant `shardBy` keys each
 * identity to one entry; `compile` writes it to shard 0.
 */
const merge = (
  into: Changes,
  model: ResolvedModel,
  key: DatabaseKey,
  values: Values,
) =>
  recordAggregate(
    into,
    model,
    Object.fromEntries(shapeOf(model).key.map((field, at) => [field, key[at]])),
    values,
    "",
  );

const mergeAll = (into: Changes, changes: Iterable<AggregateChange>) => {
  for (const change of changes) {
    merge(into, change.model, change.key, valuesOf(change));
  }
  return into;
};

/** A row's metrics as values to merge: counters, gauges, and the sketches it has. */
const metricsOf = (model: ResolvedModel, row: StoredRow): Values => {
  const { counters, gauges, distinct } = shapeOf(model);
  return Object.fromEntries([
    ...[...counters, ...gauges].map((name) => [name, Number(row[name] ?? 0)]),
    ...distinct.flatMap((name) =>
      row[name] === null || row[name] === undefined ? [] : [[name, row[name]]],
    ),
  ]);
};

/** A shard row before its first change: every metric zero or empty. */
const blank = (model: ResolvedModel, key: DatabaseKey): StoredRow => {
  const { counters, gauges, distinct } = shapeOf(model);
  return Object.fromEntries([
    ...model.table.key.map((column, at) => [column, key[at]!]),
    ...[...counters, ...gauges].map((name) => [name, 0]),
    ...distinct.map((name) => [name, null]),
    [DATABASE_VERSION_COLUMN, 0],
  ]);
};

/** Whether a change needs its row: sketches merge, and a gauge may reach zero. */
const rewrites = ({ model, deltas, sketches }: AggregateChange) =>
  Object.keys(sketches).length > 0 ||
  shapeOf(model).gauges.some((gauge) => (deltas[gauge] ?? 0) !== 0);

const increment = (
  { model, deltas }: AggregateChange,
  key: DatabaseKey,
): WriteOp | undefined =>
  Object.values(deltas).some((delta) => delta !== 0)
    ? {
        type: "increment",
        table: model.table,
        key,
        by: deltas,
        init: blank(model, key),
      }
    : undefined;

/**
 * The guarded write that merges `change` into `current`: insert, patch, or
 * delete at zero. Unlike a transaction's, a gauge may go below zero here: a
 * group can hold a loss without the gain before it, and reads sum every shard.
 */
const rewrite = (
  change: AggregateChange,
  key: DatabaseKey,
  current: StoredRow | null,
): WriteOp | undefined => {
  const { model } = change;
  const { table } = model;
  const { counters, gauges, distinct } = shapeOf(model);
  const base = current ?? blank(model, key);
  const sum = mergeAll(new Map(), [change]);
  merge(sum, model, key, metricsOf(model, base));
  const set = valuesOf([...sum.values()][0]!) as StoredRow;
  if (current && Object.keys(set).every((name) => current[name] === set[name]))
    return undefined;
  const row = { ...base, ...set };
  const zero =
    distinct.length === 0 &&
    [...counters, ...gauges].every((name) => Number(row[name]) === 0);
  if (current === null)
    return zero ? undefined : { type: "insert", table, row };
  const guard = { v: Number(current[DATABASE_VERSION_COLUMN]) };
  return zero
    ? { type: "delete", table, key, guard, previous: current }
    : { type: "patch", table, key, set, guard, previous: current };
};

/** A shard row's place in what `readCurrent` read. */
const rowId = (model: ResolvedModel, key: DatabaseKey) =>
  JSON.stringify([model.table.name, key]);

/** The shard key each change writes: shard 0, since one compaction runs at a time. */
const keysOf = (changes: readonly AggregateChange[]) =>
  changes.map(({ key }) => [...key.slice(0, -1), 0]);

/**
 * The current rows of the changes that rewrite theirs (gauges and sketches),
 * each once, in one batch per table.
 */
const readCurrent = async (
  adapter: DatabaseAdapter,
  changes: readonly AggregateChange[],
): Promise<ReadonlyMap<string, StoredRow | null>> => {
  const keys = keysOf(changes);
  const reads = new Map<ResolvedModel, Map<string, DatabaseKey>>();
  changes.forEach((change, at) => {
    if (!rewrites(change)) return;
    const wanted = reads.get(change.model) ?? new Map<string, DatabaseKey>();
    wanted.set(rowId(change.model, keys[at]!), keys[at]!);
    reads.set(change.model, wanted);
  });
  const current = new Map<string, StoredRow | null>();
  await Promise.all(
    [...reads].map(async ([model, wanted]) => {
      const keys = [...wanted.values()];
      const rows = await adapter.get(model.table, keys);
      keys.forEach((key, at) => {
        current.set(rowId(model, key), rows[at] ?? null);
      });
    }),
  );
  return current;
};

/**
 * The write for each change: a blind increment that creates the row for
 * counters, and a guarded rewrite for gauges and sketches, over the rows
 * `current` read.
 */
const build = (
  changes: readonly AggregateChange[],
  current: ReadonlyMap<string, StoredRow | null>,
): (WriteOp | undefined)[] => {
  const keys = keysOf(changes);
  return changes.map((change, at) =>
    rewrites(change)
      ? rewrite(
          change,
          keys[at]!,
          current.get(rowId(change.model, keys[at]!)) ?? null,
        )
      : increment(change, keys[at]!),
  );
};

const isOp = (op: WriteOp | undefined): op is WriteOp => op !== undefined;

const sleep = (attempt: number) =>
  new Promise((resolve) =>
    setTimeout(resolve, Math.min(250, 5 * 2 ** attempt) * Math.random()),
  );

/** Runs of one character, where shorter: a sparse sketch packs into a few. */
const pack = (text: string) => {
  const runs = (text.match(/(.)\1*/gsu) ?? []).flatMap((run) => [
    run[0]!,
    run.length,
  ]);
  return JSON.stringify(runs).length < JSON.stringify(text).length
    ? runs
    : text;
};

const unpack = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map((item, at) => (at % 2 ? "" : item.repeat(value[at + 1])))
        .join("")
    : value;

/** Raw deflate of `text` as base64, where the runtime has `CompressionStream`. */
const deflate = async (text: string) => {
  if (typeof CompressionStream === "undefined") return undefined;
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  let binary = "";
  for (const byte of new Uint8Array(await new Response(stream).arrayBuffer()))
    binary += String.fromCharCode(byte);
  return btoa(binary);
};

const inflate = (base64: string) =>
  new Response(
    new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw")),
  ).text();

/**
 * A log row's `changes`: entries of a table, an identity, and values, as
 * JSON, or `z` and its deflate where shorter, so a row stays under the 1 KB
 * that DynamoDB bills as one unit.
 */
const encode = async (changes: Iterable<AggregateChange>) => {
  const json = JSON.stringify({
    v: 1,
    c: [...changes].map(({ model, key, deltas, sketches }) => {
      const packed = Object.entries(sketches).map(([name, sketch]) => [
        name,
        pack(sketch),
      ]);
      const values = { ...deltas, ...Object.fromEntries(packed) };
      return [model.table.name, key.slice(0, -1), values];
    }),
  });
  const zipped = await deflate(json);
  return zipped !== undefined && zipped.length < json.length
    ? `z${zipped}`
    : json;
};

interface LogRow {
  /** The log table's index in `LOG_TABLES`. */
  readonly shard: number;
  readonly row: StoredRow;
  readonly changes: Changes;
}

/** Changes to aggregates declared `batched`, as an engine runs them. */
export interface AggregateBatches {
  /** `engine.transaction`, with batched aggregate changes written as one log row. */
  transaction<R>(fn: (tx: TransactionEngine) => Promise<R>): Promise<R>;
  /** Applies what a read of `table` would miss; never throws. */
  beforeRead(table: string): Promise<void>;
  /** Applies the pending log rows now. */
  flush(): Promise<void>;
}

/**
 * Batches changes to aggregates declared `batched`. A transaction writes
 * them as one log row in its own atomic write, in place of their rows; a
 * compaction later merges log rows into the aggregates and deletes them,
 * atomically again, so each applies exactly once. One lease row keeps
 * compactions one at a time.
 */
export const createAggregateBatches = ({
  engine,
  adapter,
  schema,
  batching: { windowMs = WINDOW_MS },
  now,
}: {
  readonly engine: StorageEngine;
  readonly adapter: DatabaseAdapter;
  readonly schema: ResolvedSchema;
  readonly batching: AggregateBatching;
  readonly now: () => number;
}): AggregateBatches => {
  if (!schema.models.has(LEASE_TABLE)) {
    throw new DatabaseTransactionError(
      "An engine that batches aggregates needs aggregateBatchingModule in its schema.",
    );
  }
  const holder = crypto.randomUUID().replaceAll("-", "");
  const table = (name: string) => schema.models.get(name)!.table;
  const warned = new Set<string>();
  const warn = (what: string) => (error: unknown) => {
    if (warned.has(what)) return;
    warned.add(what);
    console.warn(`[hot-updater] Aggregate ${what} failed.`, error);
  };

  /** A log row's changes, or undefined when it names an aggregate or metric this schema lacks. */
  const decode = async (text: string): Promise<Changes | undefined> => {
    const changes: Changes = new Map();
    try {
      const json = text.startsWith("z") ? await inflate(text.slice(1)) : text;
      const { c } = JSON.parse(json) as {
        readonly c: readonly [string, DatabaseKey, Values][];
      };
      for (const [name, identity, values] of c) {
        const model = schema.models.get(name);
        if (!isBatched(model)) return undefined;
        const unpacked = Object.entries(values).map(([metric, value]) => [
          metric,
          unpack(value),
        ]);
        merge(changes, model, [...identity, 0], Object.fromEntries(unpacked));
      }
    } catch (error) {
      warn("log decoding")(error);
      return undefined;
    }
    return changes;
  };

  let nextDue = 0;
  let compacting: Promise<void> | undefined;
  /** Log rows this process read, by `[log table's index, id]`, for the deletes after a group. */
  const known = new Map<string, StoredRow>();
  /**
   * Each log table's last row of a run at its head that this process can't
   * apply (it names an aggregate or metric this schema lacks), whose reads
   * start past it. The rows wait for a process that can apply them, and a
   * restart reads them again.
   */
  const skipped: (string | undefined)[] = LOG_TABLES.map(() => undefined);
  const past = (shard: number) =>
    skipped[shard] === undefined ? {} : { range: { gt: skipped[shard] } };
  /** When a log row's transaction stamped its ID. */
  const stampOf = (id: string) => Number.parseInt(id.slice(0, 9), 36);
  const idOf = (shard: number, id: unknown) => JSON.stringify([shard, id]);

  /** The lease row as stored once `set` is written over it. */
  const leaseOp = (held: StoredRow, set: Values) => {
    const next = { ...held, ...set, _v: Number(held._v) + 1 } as StoredRow;
    const op: WriteOp = {
      type: "patch",
      table: table(LEASE_TABLE),
      key: [LEASE.id],
      set: set as StoredRow,
      guard: { v: Number(held._v) },
      previous: held,
    };
    return { op, next };
  };

  /** The lease row as stored after this process takes it, or undefined when it is held or not due. */
  const takeLease = (force: boolean) =>
    engine.transaction(async (tx): Promise<StoredRow | undefined> => {
      const at = now();
      const held = await tx.findOne(LEASE_TABLE, LEASE);
      const fields = { holder, until: at + LEASE_MS };
      if (held === null) {
        const row = { ...LEASE, ...fields, next: 0, applied: "[]" };
        tx.create(LEASE_TABLE, row);
        return { ...row, _v: 0 };
      }
      nextDue = Number(held.next);
      // This process runs one compaction at a time, so a lease it holds is
      // one a failed write left behind.
      const taken = held.holder !== holder && Number(held.until) > at;
      if (taken || (!force && nextDue > at)) return undefined;
      tx.update(LEASE_TABLE, held, fields);
      return { ...held, ...fields, _v: Number(held._v) + 1 };
    });

  /**
   * Writes `ops` once, retrying transient errors; true when it committed.
   * A conflict leaves its log rows for the next compaction; a write whose
   * outcome is unknown throws, and the next compaction reads what it did.
   */
  const commit = async (ops: WriteOp[]) => {
    for (let failures = 0; failures < ATTEMPTS; failures += 1) {
      const result = await adapter.write(ops);
      if (result.ok) return true;
      if (!("retry" in result)) return false;
      await sleep(failures);
    }
    return false;
  };

  /** Deletes the log rows `held` lists as applied, in parallel writes; true once none is left. */
  const deleteApplied = async (held: StoredRow) => {
    const applied = JSON.parse(String(held.applied)) as [number, string][];
    // Rows a previous holder applied are read again, one batch per table.
    await Promise.all(
      LOG_TABLES.map(async (name, shard) => {
        const ids = applied.flatMap(([at, id]) =>
          at === shard && !known.has(idOf(at, id)) ? [id] : [],
        );
        if (ids.length === 0) return;
        const rows = await adapter.get(
          table(name),
          ids.map((id) => [id]),
        );
        for (const row of rows) if (row) known.set(idOf(shard, row.id), row);
      }),
    );
    const rows = applied.flatMap(([shard, id]) => {
      const row = known.get(idOf(shard, id));
      return row === undefined ? [] : [{ shard, row }];
    });
    // The lease lists them as applied, so an unguarded delete is safe. A
    // store that refuses it (a role without the permission) falls back to
    // guarded deletes, which cost more but never stall the log.
    const consumed =
      adapter.deleteConsumed &&
      (await Promise.all(
        LOG_TABLES.map((name, at) => {
          const own = rows.flatMap(({ shard, row }) =>
            shard === at ? [row] : [],
          );
          return own.length > 0 && adapter.deleteConsumed!(table(name), own);
        }),
      ).then(
        () => true,
        (error: unknown) => (warn("log cleanup")(error), false),
      ));
    if (consumed) {
      for (const [shard, id] of applied) known.delete(idOf(shard, id));
      return true;
    }
    const deletes = rows.map(({ shard, row }): WriteOp => {
      const guard = { v: Number(row[DATABASE_VERSION_COLUMN]) };
      const target = table(LOG_TABLES[shard]!);
      return {
        type: "delete",
        table: target,
        key: [String(row.id)],
        guard,
        previous: row,
      };
    });
    let size = deletes.length;
    while (size > 1 && !adapter.fits(deletes.slice(0, size))) {
      size = Math.ceil(size / 2);
    }
    const chunks = [];
    for (let at = 0; at < deletes.length; at += size) {
      chunks.push(deletes.slice(at, at + size));
    }
    const done = await Promise.all(chunks.map(commit));
    if (done.includes(false)) return false;
    for (const [shard, id] of applied) known.delete(idOf(shard, id));
    return true;
  };

  /**
   * The oldest pending log rows this schema can read, a page from each
   * table; `more` when a page was full, so more may wait.
   */
  const readLogs = async () => {
    let more = false;
    const pages = await Promise.all(
      LOG_TABLES.map(async (name, shard) => {
        const page = await engine.reads.findMany(name, {
          index: "oldest",
          limit: LOG_PAGE,
          ...past(shard),
        });
        more ||= page.next !== undefined;
        const decoded = await Promise.all(
          page.rows.map(async (row) => ({
            shard,
            row,
            changes: await decode(String(row.changes)),
          })),
        );
        const settled = now() - SKIP_AFTER_MS;
        for (const { row, changes } of decoded) {
          const id = String(row.id);
          if (changes !== undefined || stampOf(id) >= settled) break;
          skipped[shard] = id;
        }
        return decoded.flatMap(({ changes, ...entry }) =>
          changes === undefined ? [] : [{ ...entry, changes }],
        );
      }),
    );
    const logs: LogRow[] = pages
      .flat()
      .sort((left, right) =>
        compareUtf8(String(left.row.id), String(right.row.id)),
      );
    return { logs, more };
  };

  /**
   * Applies the oldest pending log rows whose merged changes fit in one
   * atomic write with the lease, which lists them as applied; the rows are
   * deleted after it. A log row too large for one write applies in parts,
   * keeping the rest in it. Returns the lease after the write and how many
   * log rows it applied whole, or undefined when a conflict stopped it.
   */
  const applyGroup = async (held: StoredRow, logs: readonly LogRow[]) => {
    // Every halving writes rows of these: read once for the group, from each
    // log row's changes, since gauge moves that cancel over the group may
    // not cancel over the part a halving writes.
    const current = await readCurrent(
      adapter,
      logs.flatMap((entry) => [...entry.changes.values()]),
    );
    const rowsFor = (changes: readonly AggregateChange[]) =>
      build(changes, current).filter(isOp);
    for (let count = logs.length; count > 0; count = Math.floor(count / 2)) {
      const batch = logs.slice(0, count);
      const changes = mergeAll(
        new Map(),
        batch.flatMap((entry) => [...entry.changes.values()]),
      );
      const applied = batch.map(({ shard, row }) => [shard, row.id]);
      const lease = leaseOp(held, { applied: JSON.stringify(applied) });
      const ops = [...rowsFor([...changes.values()]), lease.op];
      if (!adapter.fits(ops)) continue;
      for (const { shard, row } of batch) known.set(idOf(shard, row.id), row);
      return (await commit(ops)) ? { held: lease.next, count } : undefined;
    }
    const [{ shard, row, changes }] = logs as [LogRow];
    const name = LOG_TABLES[shard]!;
    const entries = [...changes.values()];
    for (let take = entries.length - 1; take > 0; take = Math.floor(take / 2)) {
      const kept: WriteOp = {
        type: "patch",
        table: table(name),
        key: [String(row.id)],
        set: { changes: await encode(entries.slice(take)) },
        guard: { v: Number(row[DATABASE_VERSION_COLUMN]) },
        previous: row,
      };
      const lease = leaseOp(held, {});
      const ops = [...rowsFor(entries.slice(0, take)), kept, lease.op];
      if (adapter.fits(ops)) {
        return (await commit(ops)) ? { held: lease.next, count: 0 } : undefined;
      }
    }
    throw new DatabaseTransactionError(
      `${name}: one aggregate change does not fit in one write.`,
    );
  };

  /**
   * Applies up to `groups` groups under the lease, deleting each group's log
   * rows before the next; the next compaction is due at once when some are
   * left. The lease release clears the applied list once its rows are gone.
   */
  const run = async (force: boolean, groups: number) => {
    let held = await takeLease(force);
    if (held === undefined) return;
    let pending = true;
    let clear = false;
    // Rows read and not yet applied, which the next group takes first.
    let carried: { logs: readonly LogRow[]; more: boolean } | undefined;
    try {
      for (let group = 0; ; group += 1) {
        clear = await deleteApplied(held);
        if (!clear || !pending || group === groups) break;
        const { logs, more } = carried ?? (await readLogs());
        if (logs.length === 0) {
          pending = false;
          break;
        }
        const applied = await applyGroup(held, logs);
        if (applied === undefined) break;
        [held, clear] = [applied.held, false];
        // A row split in parts changed; the next group reads it again.
        const rest = applied.count === 0 ? [] : logs.slice(applied.count);
        carried = rest.length > 0 ? { logs: rest, more } : undefined;
        pending = more || applied.count < logs.length;
      }
    } finally {
      nextDue = now() + (pending ? 0 : windowMs);
      const set = {
        until: 0,
        next: nextDue,
        ...(clear ? { applied: "[]" } : {}),
      };
      await commit([leaseOp(held, set).op]);
      known.clear();
    }
  };

  /** One compaction at a time in this process; never rejects. */
  const compact = (force: boolean, groups: number): Promise<void> =>
    (compacting ??= run(force, groups)
      .catch(warn("compaction"))
      .finally(() => {
        compacting = undefined;
      }));

  let checking: Promise<boolean> | undefined;
  /** Whether any log row waits; reads at once share one check. */
  const hasPending = () =>
    (checking ??= Promise.all(
      LOG_TABLES.map((name, shard) =>
        engine.reads.findMany(name, {
          index: "oldest",
          limit: 1,
          ...past(shard),
        }),
      ),
    )
      .then((pages) => pages.some((page) => page.rows.length > 0))
      .finally(() => {
        checking = undefined;
      }));

  return {
    async transaction(fn) {
      let changes: Changes = new Map();
      const result = await engine.transaction(async (tx) => {
        const attempt: Changes = new Map();
        changes = attempt;
        let open = true;
        let failure: { readonly error: unknown } | undefined;
        const aggregate: TransactionEngine["aggregate"] = (
          name,
          identity,
          values,
          options,
        ) => {
          const model = schema.models.get(name);
          if (!isBatched(model)) {
            return tx.aggregate(name, identity, values, options);
          }
          try {
            if (!open) {
              throw new DatabaseTransactionError("The transaction has ended.");
            }
            recordAggregate(attempt, model, identity, values, options?.shardBy);
          } catch (error) {
            failure ??= { error };
            throw error;
          }
        };
        try {
          const value = await fn({ ...tx, aggregate });
          if (failure) throw failure.error;
          if (attempt.size > 0) {
            const stamp = now().toString(36).padStart(9, "0");
            const id = `${stamp}${holder.slice(0, 8)}${crypto.randomUUID().slice(0, 8)}`;
            const shard = Math.floor(Math.random() * LOG_TABLES.length);
            const merged = mergeAll(new Map(), attempt.values());
            tx.create(LOG_TABLES[shard]!, {
              id,
              changes: await encode(merged.values()),
            });
          }
          return value;
        } finally {
          open = false;
        }
      });
      if (changes.size > 0 && now() >= nextDue) {
        await compact(false, GROUPS.commit);
      }
      return result;
    },

    async beforeRead(name) {
      if (!isBatched(schema.models.get(name))) return;
      const pending = await hasPending().catch((error: unknown) => {
        warn("read")(error);
        return false;
      });
      if (pending) await compact(true, GROUPS.read);
    },

    async flush() {
      if (await hasPending()) await compact(true, GROUPS.flush);
    },
  };
};
