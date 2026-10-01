import {
  addDistinct,
  aggregateBatchingTables,
  type AggregateBatching,
  countDistinct,
  createEngine,
  createMemoryAdapter,
  type DatabaseAdapter,
  type ModuleSchema,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import { afterEach, describe, expect, it } from "vitest";

import { runContentionHarness } from "./runContentionHarness";

type Row = Readonly<Record<string, unknown>>;

interface Transaction {
  findOne(model: string, lookup: Row): Promise<Row | null>;
  create(model: string, row: Row): void;
  update(model: string, row: Row, set: Row): void;
  aggregate(
    model: string,
    identity: Row,
    changes: Row,
    options?: { readonly shardBy?: string },
  ): void;
}

interface Database {
  transaction(fn: (tx: Transaction) => Promise<void>): Promise<void>;
  findAggregates(
    model: string,
    options: {
      readonly index: string;
      readonly where: Row;
      readonly limit: number;
    },
  ): Promise<{ readonly rows: readonly Row[] }>;
}

export interface AggregateBatchingSuiteOptions {
  readonly name: string;
  /** Returns an adapter over an empty store; each case calls it once. */
  readonly createAdapter: () => Promise<{
    readonly adapter: DatabaseAdapter;
    readonly cleanup?: () => Promise<void>;
  }>;
  /** Aggregate rows one transaction changes in the too-large case: more than one write takes. */
  readonly oversizedRows: number;
}

const identity = (name: string) => ({
  [name]: { type: "string" as const, maxLength: 16 },
});

/**
 * A plugin's tables, shaped like `defineTable` and `defineAggregate` build
 * them, under their own names.
 */
const plugin = {
  id: "batching",
  schemaVersion: "1",
  namespace: false,
  schema: {
    installs: {
      kind: "table",
      fields: {
        id: { type: "string", maxLength: 64 },
        release: { type: "string", maxLength: 16 },
      },
      key: ["id"],
      derived: {},
      indexes: {},
    },
    distribution: {
      kind: "aggregate",
      fields: identity("release"),
      key: ["release"],
      counters: [],
      gauges: ["installations"],
      distinct: [],
      shards: 8,
      batched: true,
      indexes: { byRelease: { eq: ["release"], sort: [] } },
    },
    opens: {
      kind: "aggregate",
      fields: { day: { type: "integer" } },
      key: ["day"],
      counters: ["opens"],
      gauges: [],
      distinct: [],
      shards: 4,
      batched: true,
      indexes: { all: { eq: [], sort: ["day"] } },
    },
    users: {
      kind: "aggregate",
      fields: { day: { type: "integer" } },
      key: ["day"],
      counters: [],
      gauges: [],
      distinct: ["users"],
      shards: 4,
      batched: true,
      indexes: { all: { eq: [], sort: ["day"] } },
    },
  } as unknown as ModuleSchema,
} as const;

const RELEASES = ["A", "B", "C"] as const;

/** Step `step`: 12 installations, each moving to the next release every round of 12. */
const stepOf = (step: number) => ({
  id: `i${step % 12}`,
  release: RELEASES[(Math.floor(step / 12) + step) % 3]!,
  day: 1 + (step % 2),
});

/** An installation opens the app on `release`, moving its gauge when the release changed. */
const open = (db: Database, step: number) => {
  const { id, release, day } = stepOf(step);
  return db.transaction(async (tx) => {
    const head = await tx.findOne("installs", { id });
    if (head === null) {
      tx.create("installs", { id, release });
    } else if (head.release !== release) {
      tx.update("installs", head, { release });
      const from = { release: head.release };
      tx.aggregate(
        "distribution",
        from,
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
    const users = addDistinct(null, id);
    tx.aggregate("users", { day }, { users }, { shardBy: id });
  });
};

/** Every aggregate as reads see it, sketches as their estimates. */
const snapshot = async (db: Database) => {
  const read = (model: string, index: string, where: Row = {}) =>
    db.findAggregates(model, { index, where, limit: 100 });
  const releases = await Promise.all(
    RELEASES.map((release) => read("distribution", "byRelease", { release })),
  );
  const [opens, users] = await Promise.all([
    read("opens", "all"),
    read("users", "all"),
  ]);
  return {
    distribution: releases.flatMap(({ rows }) => rows),
    opens: opens.rows,
    users: users.rows.map((row) => ({
      day: row.day,
      users: countDistinct(row.users as string),
    })),
  };
};

/**
 * Aggregates declared `batched` on a key-value store: log rows the store
 * writes with each transaction and a compaction merges once, and a memory
 * buffer, read back exactly as transactional writes read.
 */
export const setupAggregateBatchingTestSuite = ({
  name,
  createAdapter,
  oversizedRows,
}: AggregateBatchingSuiteOptions): void => {
  const tables = [
    ...toolingTargetOf([plugin]).schema.tables,
    ...aggregateBatchingTables,
  ];
  const cleanups: (() => Promise<void>)[] = [];
  const store = async () => {
    const { adapter, cleanup } = await createAdapter();
    if (cleanup) cleanups.push(cleanup);
    await adapter.migrations?.apply(tables);
    return adapter;
  };
  /** A server's engine on `adapter`, batching as `batching` says. */
  const server = (adapter: DatabaseAdapter, batching?: AggregateBatching) => {
    const engine = createEngine(
      {
        name,
        adapter,
        ...(batching === undefined ? {} : { aggregateBatching: batching }),
      },
      { plugins: [plugin], retry: { attempts: 64 } },
    );
    return {
      db: engine.database(plugin) as unknown as Database,
      flush: engine.flush,
    };
  };
  /** The reference: transactional writes on a memory adapter. */
  const expected = async (steps: number) => {
    const memory = createMemoryAdapter();
    await memory.migrations?.apply(tables);
    const { db } = server(memory);
    for (let step = 0; step < steps; step += 1) await open(db, step);
    return snapshot(db);
  };

  describe(`${name} aggregate batching`, () => {
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    });

    for (const mode of ["log", "memory"] as const) {
      it(`reads what transactional writes read, in ${mode} mode`, async () => {
        const { db } = server(await store(), { mode });
        for (let step = 0; step < 36; step += 1) await open(db, step);
        expect(await snapshot(db)).toEqual(await expected(36));
      }, 120_000);
    }

    it("applies each log row once when two servers compact while 16 writers commit", async () => {
      const adapter = await store();
      const first = server(adapter, { mode: "log", windowMs: 0 });
      const second = server(adapter, { mode: "log", windowMs: 0 });
      // Each installation's opens run in order; installations run at once.
      const report = await runContentionHarness({
        transactions: 12,
        ratePerSecond: 1_000,
        concurrency: 16,
        run: async (install) => {
          for (let round = 0; round < 4; round += 1) {
            const db = (install + round) % 2 === 0 ? first.db : second.db;
            await open(db, round * 12 + install);
          }
        },
      });
      expect(report.errors).toEqual({});
      await Promise.all([first.flush(), second.flush()]);
      await first.flush();
      expect(await snapshot(second.db)).toEqual(await expected(48));
    }, 300_000);

    it("applies a log row larger than one write in parts, each change once", async () => {
      const { db, flush } = server(await store(), { mode: "log" });
      await db.transaction(async (tx) => {
        for (let day = 1; day <= oversizedRows; day += 1) {
          tx.aggregate("opens", { day }, { opens: day }, { shardBy: "i" });
        }
      });
      await flush();
      const { rows } = await db.findAggregates("opens", {
        index: "all",
        where: {},
        limit: 500,
      });
      const days = Math.min(oversizedRows, 500);
      expect(rows).toHaveLength(days);
      expect(rows.every((row) => row.opens === row.day)).toBe(true);
    }, 300_000);
  });
};
