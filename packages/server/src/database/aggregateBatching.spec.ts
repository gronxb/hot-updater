import type { AggregateBatching } from "@hot-updater/plugin-core";
import {
  addInsightsDistinct,
  countInsightsDistinct,
  createMemoryAdapter,
  type DatabaseAdapter,
  type WriteOp,
  type WriteResult,
} from "@hot-updater/plugin-core/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { aggregateBatchingModule } from "./aggregateBatching";
import { createDatabaseEngine } from "./database";
import { resolveSchema } from "./resolveSchema";
import { defineAggregate, defineTable } from "./schema";

const installs = defineTable(
  {
    id: { type: "string", maxLength: 64 },
    release: { type: "string", maxLength: 16 },
  },
  { key: ["id"] },
);

/** Installations by the release they run: a gauge each move takes from one row and gives another. */
const distribution = defineAggregate(
  { release: { type: "string", maxLength: 16 } },
  {
    key: ["release"],
    gauges: ["installations"],
    shards: 8,
    batched: true,
    indexes: { byRelease: { eq: ["release"], sort: [] } },
  },
);

const opens = defineAggregate(
  { day: { type: "integer" } },
  {
    key: ["day"],
    counters: ["opens", "failures"],
    shards: 4,
    batched: true,
    indexes: { all: { eq: [], sort: ["day"] } },
  },
);

const users = defineAggregate(
  { day: { type: "integer" } },
  {
    key: ["day"],
    distinct: ["users"],
    shards: 4,
    batched: true,
    indexes: { all: { eq: [], sort: ["day"] } },
  },
);

/** Not batched: it commits with each transaction, batching or not. */
const totals = defineAggregate(
  { scope: { type: "string", maxLength: 16 } },
  {
    key: ["scope"],
    counters: ["hits"],
    indexes: { all: { eq: [], sort: ["scope"] } },
  },
);

const module = {
  id: "stats",
  schema: { installs, distribution, opens, users, totals },
} as const;
const plain = resolveSchema([module]);
const batched = resolveSchema([module, aggregateBatchingModule]);
const table = (name: string) => batched.models.get(name)!.table;
const LOG_TABLES = Array.from({ length: 8 }, (_, at) => `aggregate_log_${at}`);

const sketchOf = (id: string) => addInsightsDistinct(null, id);

interface Setup {
  readonly batching?: AggregateBatching;
  readonly adapter?: DatabaseAdapter;
  /** Answers a write in place of the store, which `write` reaches; undefined writes as usual. */
  readonly fault?: (
    ops: readonly WriteOp[],
    write: DatabaseAdapter["write"],
  ) => WriteResult | Promise<WriteResult | undefined> | undefined;
  readonly maxOps?: number;
}

const setup = async ({ batching, adapter, fault, maxOps }: Setup = {}) => {
  const memory = createMemoryAdapter(maxOps === undefined ? {} : { maxOps });
  const schema = batching === undefined ? plain : batched;
  if (adapter === undefined) await memory.migrations?.apply(schema.tables);
  const base = adapter ?? memory;
  const writes: (readonly WriteOp[])[] = [];
  const clock = { now: 1_000_000 };
  const engine = createDatabaseEngine({
    adapter: {
      ...base,
      async write(ops) {
        writes.push(ops);
        return (
          (await fault?.(ops, (given) => base.write(given))) ?? base.write(ops)
        );
      },
    },
    schema,
    retry: { attempts: 8, baseDelayMs: 0, maxDelayMs: 1 },
    ...(batching === undefined ? {} : { batching, now: () => clock.now }),
  });
  return {
    memory: base,
    writes,
    clock,
    engine,
    db: engine.database(module),
  };
};

type Db = Awaited<ReturnType<typeof setup>>["db"];

/** An installation opens the app on `release`, moving its gauge when the release changed. */
const open = (db: Db, id: string, release: string, day = 1) =>
  db.transaction(async (tx) => {
    const head = await tx.findOne("installs", { id });
    if (head === null) {
      tx.create("installs", { id, release });
    } else if (head.release !== release) {
      tx.update("installs", head, { release });
      tx.aggregate(
        "distribution",
        { release: head.release },
        { installations: -1 },
        { shardBy: id },
      );
    }
    if (head?.release !== release) {
      tx.aggregate(
        "distribution",
        { release },
        { installations: 1 },
        { shardBy: id },
      );
    }
    tx.aggregate("opens", { day }, { opens: 1 }, { shardBy: id });
    tx.aggregate("users", { day }, { users: sketchOf(id) }, { shardBy: id });
    tx.aggregate("totals", { scope: "all" }, { hits: 1 });
  });

/** Every aggregate as reads see it. */
const snapshot = async (db: Db) => {
  const [releases, days, sketches, scopes] = await Promise.all([
    Promise.all(
      ["A", "B", "C"].map((release) =>
        db.findAggregates("distribution", {
          index: "byRelease",
          where: { release },
          limit: 10,
        }),
      ),
    ),
    db.findAggregates("opens", { index: "all", where: {}, limit: 10 }),
    db.findAggregates("users", { index: "all", where: {}, limit: 10 }),
    db.findAggregates("totals", { index: "all", where: {}, limit: 10 }),
  ]);
  return {
    distribution: releases.flatMap(({ rows }) => rows),
    opens: days.rows,
    users: sketches.rows.map((row) => ({
      day: row.day,
      users: countInsightsDistinct(row.users),
    })),
    totals: scopes.rows,
  };
};

const logRows = async (memory: DatabaseAdapter) =>
  (
    await Promise.all(
      LOG_TABLES.map((name) =>
        memory.query(table(name), {
          index: "oldest",
          eq: [],
          order: "asc",
          limit: 500,
        }),
      ),
    )
  ).flat();

const RELEASES = ["A", "B", "C"] as const;
/** Step `step` of the traffic: 12 installations, each moving to the next release every round. */
const stepOf = (step: number) => ({
  id: `i${step % 12}`,
  release: RELEASES[(Math.floor(step / 12) + step) % 3]!,
  day: 1 + (step % 2),
});

/** 60 opens: five rounds of 12 installations over 3 releases and 2 days. */
const traffic = async (db: Db) => {
  for (let step = 0; step < 60; step += 1) {
    const { id, release, day } = stepOf(step);
    await open(db, id, release, day);
  }
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("aggregate batching", () => {
  it("writes one log row with each transaction instead of its batched aggregate rows", async () => {
    const { db, writes, memory, clock } = await setup({
      batching: { mode: "log", windowMs: 60_000 },
    });
    await open(db, "i1", "A");
    writes.length = 0;
    clock.now += 1_000;
    await open(db, "i1", "B");

    // Not due yet: the first commit compacted, and the window has not passed.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.map((op) => [op.type, op.table.name])).toEqual([
      ["insert", expect.stringMatching(/^aggregate_log_\d$/)],
      ["patch", "installs"],
      ["increment", "totals"],
    ]);
    expect(await logRows(memory)).toHaveLength(1);
  });

  it("reads what log, memory, and transactional writes all read, whichever writes it", async () => {
    const reference = await setup();
    const log = await setup({ batching: { mode: "log", windowMs: 60_000 } });
    const memory = await setup({ batching: { mode: "memory" } });
    for (const { db } of [reference, log, memory]) await traffic(db);

    const expected = await snapshot(reference.db);
    expect(expected.distribution.map((row) => row.installations)).toEqual([
      4, 4, 4,
    ]);
    expect(await snapshot(log.db)).toEqual(expected);
    expect(await snapshot(memory.db)).toEqual(expected);
    expect(await logRows(log.memory)).toEqual([]);
  });

  it("writes each batched row once per compaction, however many transactions changed it", async () => {
    const reference = await setup();
    const log = await setup({ batching: { mode: "log", windowMs: 60_000 } });
    await traffic(reference.db);
    await traffic(log.db);
    await log.engine.flush();

    const aggregateOps = (writes: readonly (readonly WriteOp[])[]) =>
      writes
        .flat()
        .filter(({ table: { name } }) =>
          ["distribution", "opens", "users"].includes(name),
        ).length;
    // One compaction after the first commit, one on flush: a few rows each.
    expect(aggregateOps(log.writes)).toBeLessThanOrEqual(10);
    expect(aggregateOps(reference.writes)).toBeGreaterThan(150);
  });

  it("applies each log row once when a compaction write's outcome is lost", async () => {
    const reference = await setup();
    await traffic(reference.db);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The group write (aggregate rows and the lease listing them as applied),
    // then the deletes after it: each lost after it committed, or before.
    const writes = {
      group: (ops: readonly WriteOp[]) =>
        ops.some(({ table: { name } }) => name === "opens"),
      deletes: (ops: readonly WriteOp[]) =>
        ops.every((op) => op.type === "delete"),
    };
    for (const [kind, matches] of Object.entries(writes)) {
      for (const applied of [true, false]) {
        let lose = false;
        const log = await setup({
          batching: { mode: "log", windowMs: 60_000 },
          fault: async (ops, write) => {
            if (!lose || !matches(ops)) return undefined;
            lose = false;
            if (applied) await write(ops);
            throw new Error("socket hang up");
          },
        });
        await traffic(log.db);
        lose = true;
        await log.engine.flush();
        expect(lose, `${kind} write`).toBe(false);
        expect(warn).toHaveBeenLastCalledWith(
          "[hot-updater] Aggregate compaction failed.",
          expect.any(Error),
        );
        expect(await snapshot(log.db)).toEqual(await snapshot(reference.db));
        expect(await logRows(log.memory)).toEqual([]);
      }
    }
  });

  it("deletes applied log rows through the adapter's unguarded delete, and falls back when it fails", async () => {
    const reference = await setup();
    await traffic(reference.db);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const refused of [false, true]) {
      const memory = createMemoryAdapter();
      await memory.migrations?.apply(batched.tables);
      let consumed = 0;
      const log = await setup({
        batching: { mode: "log", windowMs: 60_000 },
        adapter: {
          ...memory,
          async deleteConsumed(physical, rows) {
            // A role without the permission is refused before it deletes.
            if (refused) throw new Error("AccessDeniedException");
            const keys = rows.map((row) => [String(row.id)]);
            const current = await memory.get(physical, keys);
            await memory.write(
              rows.flatMap((row, at) =>
                current[at] === null
                  ? []
                  : [
                      {
                        type: "delete" as const,
                        table: physical,
                        key: keys[at]!,
                        guard: { v: Number(row._v) },
                        previous: row,
                      },
                    ],
              ),
            );
            consumed += rows.length;
          },
        },
      });
      await traffic(log.db);
      await log.engine.flush();
      expect(await snapshot(log.db)).toEqual(await snapshot(reference.db));
      expect(await logRows(memory)).toEqual([]);
      const guarded = log.writes
        .flat()
        .filter(
          (op) =>
            op.type === "delete" && op.table.name.startsWith("aggregate_log_"),
        );
      if (refused) {
        expect(warn).toHaveBeenCalledWith(
          "[hot-updater] Aggregate log cleanup failed.",
          expect.any(Error),
        );
        expect(guarded).toHaveLength(60);
      } else {
        expect(consumed).toBe(60);
        expect(guarded).toEqual([]);
      }
    }
  });

  it("applies each log row once when two processes compact the same log", async () => {
    const shared = createMemoryAdapter();
    await shared.migrations?.apply(batched.tables);
    const reference = await setup();
    const first = await setup({
      adapter: shared,
      batching: { mode: "log", windowMs: 60_000 },
    });
    const second = await setup({
      adapter: shared,
      batching: { mode: "log", windowMs: 60_000 },
    });
    for (let step = 0; step < 60; step += 1) {
      const { id, release, day } = stepOf(step);
      await open(step % 2 === 0 ? first.db : second.db, id, release, day);
      await open(reference.db, id, release, day);
    }
    await Promise.all([first.engine.flush(), second.engine.flush()]);
    await first.engine.flush();

    expect(await snapshot(first.db)).toEqual(await snapshot(reference.db));
    expect(await logRows(shared)).toEqual([]);
  });

  it("keeps a shard row below zero when another process holds its gains, and reads the sum", async () => {
    const shared = createMemoryAdapter();
    await shared.migrations?.apply(batched.tables);
    const gain = await setup({ adapter: shared, batching: { mode: "memory" } });
    const loss = await setup({ adapter: shared, batching: { mode: "memory" } });
    // Each process picks its shard on its first flush.
    const flushOnShard = async (engine: typeof gain.engine, random: number) => {
      vi.spyOn(Math, "random").mockReturnValue(random);
      await engine.flush();
      vi.restoreAllMocks();
    };

    await open(gain.db, "i1", "A");
    await flushOnShard(gain.engine, 0);
    await open(loss.db, "i1", "B");
    await flushOnShard(loss.engine, 0.99);

    const shards = await shared.query(table("distribution"), {
      index: "byRelease",
      eq: ["A"],
      order: "asc",
      limit: 10,
    });
    expect(shards.map((row) => [row._shard, row.installations])).toEqual([
      [0, 1],
      [7, -1],
    ]);
    const read = await gain.db.findAggregates("distribution", {
      index: "byRelease",
      where: { release: "A" },
      limit: 10,
    });
    expect(read.rows).toEqual([{ release: "A", installations: 0 }]);
  });

  it("records only the attempt that committed when a transaction reruns", async () => {
    let conflicts = 1;
    const { db, engine } = await setup({
      batching: { mode: "log", windowMs: 60_000 },
      fault: (ops) =>
        ops.some(({ table: { name } }) => name === "installs") &&
        conflicts-- > 0
          ? { ok: false, failedOp: 0 }
          : undefined,
    });
    let attempts = 0;
    await db.transaction(async (tx) => {
      attempts += 1;
      tx.create("installs", { id: "i1", release: "A" });
      tx.aggregate("opens", { day: 1 }, { opens: 1 }, { shardBy: "i1" });
    });
    await engine.flush();
    expect(attempts).toBe(2);
    expect(
      (await db.findAggregates("opens", { index: "all", where: {}, limit: 10 }))
        .rows,
    ).toEqual([{ day: 1, opens: 1, failures: 0 }]);
  });

  it("fails the transaction on an invalid batched change, even one fn caught", async () => {
    const { db, writes } = await setup({ batching: { mode: "log" } });
    await expect(
      db.transaction(async (tx) => {
        tx.create("installs", { id: "i1", release: "A" });
        try {
          tx.aggregate("distribution", { release: "A" }, { installations: 1 });
        } catch {}
      }),
    ).rejects.toThrow("gauges of a sharded aggregate need shardBy");
    expect(writes).toEqual([]);
  });

  it("splits a log row too large for one write, applying every change once", async () => {
    const reference = await setup();
    // Three ops a write: one change and its log row's patch, or two and its delete.
    const log = await setup({
      batching: { mode: "log", windowMs: 60_000 },
      maxOps: 3,
    });
    const five = (db: Db) =>
      db.transaction(async (tx) => {
        for (let day = 1; day <= 5; day += 1) {
          tx.aggregate("opens", { day }, { opens: day }, { shardBy: "i1" });
        }
      });
    await five(reference.db);
    await five(log.db);
    await log.engine.flush();
    expect(await snapshot(log.db)).toEqual(await snapshot(reference.db));
    expect(await logRows(log.memory)).toEqual([]);
  });

  it("serves stored aggregates when a read cannot compact", async () => {
    const reference = await setup();
    const log = await setup({
      batching: { mode: "log", windowMs: 60_000 },
    });
    await open(reference.db, "i1", "A");
    await open(log.db, "i1", "A");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const readOnly = await setup({
      adapter: log.memory,
      batching: { mode: "log", windowMs: 60_000 },
      fault: () => {
        throw new Error("AccessDeniedException");
      },
    });
    await open(log.db, "i2", "B");

    const stale = await snapshot(readOnly.db);
    expect(stale.distribution).toEqual([{ release: "A", installations: 1 }]);
    expect(warn).toHaveBeenCalledWith(
      "[hot-updater] Aggregate compaction failed.",
      expect.any(Error),
    );
    await open(reference.db, "i2", "B");
    expect(await snapshot(log.db)).toEqual(await snapshot(reference.db));
  });

  it("leaves a log row naming an aggregate it lacks for a process that has it", async () => {
    const shared = createMemoryAdapter();
    await shared.migrations?.apply(batched.tables);
    const full = await setup({
      adapter: shared,
      batching: { mode: "log", windowMs: 60_000 },
    });
    const partial = createDatabaseEngine({
      adapter: shared,
      schema: resolveSchema([
        { id: "stats", schema: { installs, opens } },
        aggregateBatchingModule,
      ]),
      batching: { mode: "log" },
    });
    await open(full.db, "i1", "A");
    await open(full.db, "i1", "B");
    await partial.flush();
    expect(await logRows(shared)).toHaveLength(1);
    await full.engine.flush();
    expect(await logRows(shared)).toEqual([]);
  });

  it("keeps memory-mode changes in the process until the window passes or a read", async () => {
    vi.useFakeTimers();
    const { db, writes, memory } = await setup({
      batching: { mode: "memory", windowMs: 5_000 },
    });
    for (const id of ["i1", "i2", "i3"]) await open(db, id, "A");
    const rows = () =>
      memory.query(table("opens"), {
        index: "all",
        eq: [],
        order: "asc",
        limit: 10,
      });
    expect(await rows()).toEqual([]);
    expect(writes.flat().map((op) => op.table.name)).not.toContain("opens");

    await vi.advanceTimersByTimeAsync(5_000);
    expect((await rows()).map((row) => row.opens)).toEqual([3]);

    await open(db, "i4", "A");
    await expect(
      db.findAggregates("opens", { index: "all", where: {}, limit: 10 }),
    ).resolves.toEqual({ rows: [{ day: 1, opens: 4, failures: 0 }] });
  });

  it("keeps changes a memory flush could not write for the next flush", async () => {
    let failing = true;
    const { db, engine, memory } = await setup({
      batching: { mode: "memory" },
      fault: (ops) =>
        failing && ops.some(({ table: { name } }) => name === "opens")
          ? { ok: false, retry: true }
          : undefined,
    });
    await open(db, "i1", "A");
    await engine.flush();
    const opens = () =>
      memory.query(table("opens"), {
        index: "all",
        eq: [],
        order: "asc",
        limit: 10,
      });
    expect(await opens()).toEqual([]);
    failing = false;
    await engine.flush();
    expect((await opens()).map((row) => row.opens)).toEqual([1]);
  });
});
