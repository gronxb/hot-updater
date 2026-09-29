import type { AggregateBatching } from "@hot-updater/plugin-core";
import {
  compareUtf8,
  type DatabaseAdapter,
  type DatabaseKey,
  DATABASE_VERSION_COLUMN,
  type StoredRow,
  type WriteOp,
  type WriteResult,
} from "@hot-updater/plugin-core/internal";

import type { AggregateShape } from "./definitions";
import type { Engine } from "./engine";
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
const WINDOW_MS = 15_000;
/** Log rows a compaction reads from each log table at once. */
const LOG_PAGE = 50;
/** Atomic writes one compaction makes: after a commit, before a read, and on flush. */
const CHUNKS = { commit: 4, read: 16, flush: 256 } as const;
/** Tries per write after a conflict or a transient error. */
const ATTEMPTS = 5;
/** Aggregate rows a memory buffer holds before a commit waits for a flush. */
const MAX_BUFFERED = 10_000;

const log = defineTable(
  {
    id: { type: "string", maxLength: 32 },
    /** One committed transaction's changes, one entry per aggregate row. */
    changes: { type: "string" },
  },
  { key: ["id"], indexes: { oldest: { eq: [], sort: ["id"] } } },
);

/** Held by `holder` until `until`; the next compaction is due at `next`. */
const lease = defineTable(
  {
    id: { type: "string", maxLength: 16 },
    holder: { type: "string", maxLength: 32 },
    until: { type: "integer" },
    next: { type: "integer" },
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
type Shard = (model: ResolvedModel) => number;

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
 * identity to one entry; the write picks the shard.
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
 * shard row holds one writer's net changes, and reads sum every shard.
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

/**
 * The write for each change on its shard: a blind increment that creates
 * the row for counters, and a guarded rewrite for gauges and sketches, whose
 * rows are read in one batch per table.
 */
const compile = async (
  adapter: DatabaseAdapter,
  changes: readonly AggregateChange[],
  shard: Shard,
): Promise<(WriteOp | undefined)[]> => {
  const keys = changes.map(({ model, key }) => [
    ...key.slice(0, -1),
    shard(model),
  ]);
  const reads = new Map<ResolvedModel, number[]>();
  changes.forEach((change, at) => {
    if (rewrites(change)) {
      reads.set(change.model, [...(reads.get(change.model) ?? []), at]);
    }
  });
  const current = new Map<number, StoredRow | null>();
  await Promise.all(
    [...reads].map(async ([model, positions]) => {
      const rows = await adapter.get(
        model.table,
        positions.map((at) => keys[at]!),
      );
      positions.forEach((at, index) => current.set(at, rows[index] ?? null));
    }),
  );
  return changes.map((change, at) =>
    current.has(at)
      ? rewrite(change, keys[at]!, current.get(at)!)
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

/** A log row's `changes`: each entry is a table, an identity, and values. */
const encode = (changes: Iterable<AggregateChange>): string =>
  JSON.stringify({
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

interface LogRow {
  readonly table: string;
  readonly row: StoredRow;
  readonly changes: Changes;
}

/** A process's view of changes to aggregates declared `batched`. */
export interface AggregateBatches {
  /** `engine.transaction`, with batched aggregate changes held back until commit. */
  transaction<R>(fn: (tx: TransactionEngine) => Promise<R>): Promise<R>;
  /** Applies what a read of `table` would miss; never throws. */
  beforeRead(table: string): Promise<void>;
  /** Applies this process's buffer and the pending log rows now. */
  flush(): Promise<void>;
  /** Flushes, and stops the flush timer. */
  dispose(): Promise<void>;
}

/**
 * Batches changes to aggregates declared `batched`. A transaction records
 * them without writing their rows; once it commits, "memory" mode keeps
 * them in this process until its timer flushes them, and "log" mode has
 * written them as one log row in the same atomic write, which a compaction
 * later merges into the aggregates and deletes, atomically again, so each
 * applies exactly once. One lease row keeps compactions one at a time.
 */
export const createAggregateBatches = ({
  engine,
  adapter,
  schema,
  batching: { mode = "log", windowMs = WINDOW_MS },
  now,
}: {
  readonly engine: Engine;
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
  const warned = new Set<string>();
  const warn = (what: string) => (error: unknown) => {
    if (warned.has(what)) return;
    warned.add(what);
    console.warn(`[hot-updater] Aggregate ${what} failed.`, error);
  };

  /** A log row's changes, or undefined when it names an aggregate or metric this schema lacks. */
  const decode = (text: string): Changes | undefined => {
    const changes: Changes = new Map();
    try {
      const { c } = JSON.parse(text) as {
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

  /**
   * Writes changes in atomic chunks within `fits`, and returns the ones it
   * could not apply. A write whose outcome is unknown is dropped, never
   * resent, so no change applies twice.
   */
  const apply = async (
    changes: readonly AggregateChange[],
    shard: Shard,
  ): Promise<readonly AggregateChange[]> => {
    let rest = changes;
    let ops: (WriteOp | undefined)[] = [];
    let read = true;
    for (let failures = 0; rest.length > 0 && failures < ATTEMPTS; ) {
      try {
        if (read) ops = await compile(adapter, rest, shard);
        let size = rest.length;
        const chunk = () => ops.slice(0, size).filter(isOp);
        while (size > 1 && !adapter.fits(chunk())) size = Math.ceil(size / 2);
        let result: WriteResult = { ok: true };
        if (chunk().length > 0) {
          result = await adapter.write(chunk()).catch((error: unknown) => {
            warn("flush")(error);
            return { ok: true } as const;
          });
        }
        read = !result.ok && !("retry" in result);
        if (result.ok) {
          rest = rest.slice(size);
          ops = ops.slice(size);
          failures = 0;
        } else {
          failures += 1;
          if (!read) await sleep(failures);
        }
      } catch (error) {
        warn("flush")(error);
        return rest;
      }
    }
    return rest;
  };

  // "memory": this process's changes, flushed on a timer.
  let buffer: Changes = new Map();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  const shards = new Map<ResolvedModel, number>();
  /** Each process writes its own shard, so flushes of two processes rarely meet. */
  const processShard: Shard = (model) => {
    if (!shards.has(model)) {
      shards.set(model, Math.floor(Math.random() * shapeOf(model).shards));
    }
    return shards.get(model)!;
  };
  const schedule = () => {
    if (timer !== undefined || buffer.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flushBuffer();
    }, windowMs);
    // A pending flush never keeps the process alive.
    (timer as { unref?: () => void }).unref?.();
  };
  /** Never rejects: what it cannot apply goes back into the buffer. */
  const flushBuffer = (): Promise<void> =>
    (flushing ??= (async () => {
      clearTimeout(timer);
      timer = undefined;
      const pending = [...buffer.values()];
      buffer = new Map();
      mergeAll(buffer, await apply(pending, processShard));
    })()
      .catch(warn("flush"))
      .finally(() => {
        flushing = undefined;
        schedule();
      }));

  // "log": log rows, compacted under the lease.
  let nextDue = 0;
  let compacting: Promise<void> | undefined;

  const takeLease = (force: boolean) =>
    engine.transaction(async (tx) => {
      const at = now();
      const held = await tx.findOne(LEASE_TABLE, LEASE);
      const fields = { holder, until: at + LEASE_MS };
      if (held === null) {
        tx.create(LEASE_TABLE, { ...LEASE, ...fields, next: 0 });
        return true;
      }
      nextDue = Number(held.next);
      if (Number(held.until) > at || (!force && nextDue > at)) return false;
      tx.update(LEASE_TABLE, held, fields);
      return true;
    });

  const releaseLease = (next: number) =>
    engine.transaction(async (tx) => {
      const held = await tx.findOne(LEASE_TABLE, LEASE);
      if (held?.holder === holder) {
        tx.update(LEASE_TABLE, held, { until: 0, next });
      }
    });

  /** The oldest pending log rows this schema can read, a page from each table. */
  const readLogs = async (): Promise<LogRow[]> => {
    const pages = await Promise.all(
      LOG_TABLES.map(async (name) => {
        const page = await engine.reads.findMany(name, {
          index: "oldest",
          limit: LOG_PAGE,
        });
        return page.rows.flatMap((row) => {
          const changes = decode(String(row.changes));
          return changes === undefined ? [] : [{ table: name, row, changes }];
        });
      }),
    );
    return pages
      .flat()
      .sort((left, right) =>
        compareUtf8(String(left.row.id), String(right.row.id)),
      );
  };

  /** Deletes a log row, or keeps only `rest` of its changes. */
  const logOp = (
    { table: name, row }: LogRow,
    rest?: readonly AggregateChange[],
  ): WriteOp => {
    const target = {
      table: schema.models.get(name)!.table,
      key: [String(row.id)],
      guard: { v: Number(row[DATABASE_VERSION_COLUMN]) },
      previous: row,
    };
    return rest === undefined
      ? { type: "delete", ...target }
      : { type: "patch", ...target, set: { changes: encode(rest) } };
  };

  /**
   * Writes `ops` once, retrying transient errors; true when it committed.
   * A conflict leaves the log rows for the next compaction, and a write
   * whose outcome is unknown throws: either way no log row applies twice,
   * since it is deleted in the write that applies it.
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

  const withChanges = async (
    changes: readonly AggregateChange[],
    logOps: readonly WriteOp[],
  ) => (await compile(adapter, changes, () => 0)).filter(isOp).concat(logOps);

  /**
   * Applies the oldest log rows that fit in one atomic write with their
   * deletes, or part of one log row too large for a write, keeping the rest
   * in it. False when a conflict stopped it.
   */
  const compactChunk = async (logs: readonly LogRow[]): Promise<boolean> => {
    let count = logs.length;
    const deletes = () => logs.slice(0, count).map((entry) => logOp(entry));
    while (count > 1 && !adapter.fits(deletes())) count = Math.ceil(count / 2);
    for (; count > 0; count = Math.floor(count / 2)) {
      const batch = logs.slice(0, count);
      const changes = mergeAll(
        new Map(),
        batch.flatMap((entry) => [...entry.changes.values()]),
      );
      const ops = await withChanges([...changes.values()], deletes());
      if (adapter.fits(ops)) return commit(ops);
    }
    const [first] = logs;
    const entries = [...first!.changes.values()];
    for (let take = entries.length - 1; take > 0; take = Math.floor(take / 2)) {
      const kept = logOp(first!, entries.slice(take));
      const ops = await withChanges(entries.slice(0, take), [kept]);
      if (adapter.fits(ops)) return commit(ops);
    }
    throw new DatabaseTransactionError(
      `${first!.table}: one aggregate change does not fit in one write.`,
    );
  };

  /** Compacts up to `chunks` atomic writes; the next is due at once when some are left. */
  const run = async (force: boolean, chunks: number) => {
    if (!(await takeLease(force))) return;
    let pending = true;
    try {
      for (let chunk = 0; chunk < chunks; chunk += 1) {
        const logs = await readLogs();
        if (logs.length === 0) {
          pending = false;
          break;
        }
        if (!(await compactChunk(logs))) break;
      }
    } finally {
      nextDue = now() + (pending ? 0 : windowMs);
      await releaseLease(nextDue);
    }
  };

  /** One compaction at a time in this process; never rejects. */
  const compact = (force: boolean, chunks: number): Promise<void> =>
    (compacting ??= run(force, chunks)
      .catch(warn("compaction"))
      .finally(() => {
        compacting = undefined;
      }));

  const hasPending = async () =>
    (
      await Promise.all(
        LOG_TABLES.map((name) =>
          engine.reads.findMany(name, { index: "oldest", limit: 1 }),
        ),
      )
    ).some((page) => page.rows.length > 0);

  /** Takes a committed transaction's changes; never rejects, since the transaction already committed. */
  const committed = async (changes: Changes) => {
    if (mode === "log") {
      if (now() >= nextDue) await compact(false, CHUNKS.commit);
      return;
    }
    mergeAll(buffer, changes.values());
    schedule();
    if (buffer.size >= MAX_BUFFERED) await flushBuffer();
  };

  const flush = async () => {
    await flushBuffer();
    if (mode === "log" && (await hasPending())) {
      await compact(true, CHUNKS.flush);
    }
  };

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
          if (mode === "log" && attempt.size > 0) {
            const stamp = now().toString(36).padStart(9, "0");
            const id = `${stamp}${holder.slice(0, 8)}${crypto.randomUUID().slice(0, 8)}`;
            const shard = Math.floor(Math.random() * LOG_TABLES.length);
            const merged = mergeAll(new Map(), attempt.values());
            tx.create(LOG_TABLES[shard]!, {
              id,
              changes: encode(merged.values()),
            });
          }
          return value;
        } finally {
          open = false;
        }
      });
      if (changes.size > 0) await committed(changes);
      return result;
    },

    async beforeRead(name) {
      if (!isBatched(schema.models.get(name))) return;
      // A flush already running took the buffer: the read waits for it too.
      if (buffer.size > 0 || flushing !== undefined) await flushBuffer();
      if (mode === "log") {
        const pending = await hasPending().catch((error: unknown) => {
          warn("read")(error);
          return false;
        });
        if (pending) await compact(true, CHUNKS.read);
      }
    },

    flush,

    async dispose() {
      clearTimeout(timer);
      timer = undefined;
      await flush();
    },
  };
};
