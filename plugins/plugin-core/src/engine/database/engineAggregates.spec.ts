import {
  runContentionHarness,
  withAdapterLatency,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import {
  type DatabaseAdapter,
  type WriteOp,
  type WriteResult,
} from "../../database/adapter";
import { addDistinct, countDistinct } from "../../database/distinct";
import { createMemoryAdapter } from "../../database/memoryAdapter";
import {
  DatabaseConflictError,
  DatabaseQueryError,
  DatabaseTransactionError,
} from "../../serverPlugin/errors";
import { defineAggregate, defineTable } from "../../serverPlugin/schema";
import { createDatabaseEngine } from "./database";
import { shardOf } from "./engineAggregates";
import type { RetryOptions } from "./engineTransaction";
import { resolveSchema } from "./resolveSchema";

const installs = defineTable(
  {
    id: { type: "string", maxLength: 64 },
    release: { type: "string", maxLength: 16 },
  },
  { key: ["id"] },
);

const distribution = defineAggregate(
  { release: { type: "string", maxLength: 16 }, bucket: { type: "integer" } },
  {
    key: ["release", "bucket"],
    gauges: ["installations"],
    shards: 64,
    indexes: { byRelease: { eq: ["release"], sort: ["bucket"] } },
  },
);

const overview = defineAggregate(
  { bucket: { type: "integer" } },
  {
    key: ["bucket"],
    counters: ["events", "failures"],
    shards: 4,
    indexes: { all: { eq: [], sort: ["bucket"] } },
  },
);

const users = defineAggregate(
  { bucket: { type: "integer" } },
  {
    key: ["bucket"],
    distinct: ["users"],
    shards: 64,
    indexes: { all: { eq: [], sort: ["bucket"] } },
  },
);

const totals = defineAggregate(
  { scope: { type: "string", maxLength: 16 } },
  {
    key: ["scope"],
    counters: ["hits"],
    gauges: ["open"],
    indexes: { all: { eq: [], sort: ["scope"] } },
  },
);

const module = {
  id: "stats",
  schema: { installs, distribution, overview, users, totals },
} as const;
const schema = resolveSchema([module]);
const table = (name: string) => schema.models.get(name)!.table;

const setup = async (
  options: { readonly retry?: RetryOptions; readonly latencyMs?: number } = {},
) => {
  const memory = createMemoryAdapter();
  await memory.migrations?.apply(schema.tables);
  const faults: {
    inject?: () => WriteResult | undefined;
    /** Runs before each write reaches the store, as another writer would. */
    before?: () => Promise<void>;
  } = {};
  const writes: (readonly WriteOp[])[] = [];
  const retries = { rerun: 0, resend: 0 };
  const faulty: DatabaseAdapter = {
    ...memory,
    async write(ops) {
      writes.push(ops);
      await faults.before?.();
      return faults.inject?.() ?? memory.write(ops);
    },
  };
  const engine = createDatabaseEngine({
    adapter: options.latencyMs
      ? withAdapterLatency(faulty, options.latencyMs)
      : faulty,
    schema,
    verify: true,
    retry: {
      attempts: 8,
      baseDelayMs: 0,
      maxDelayMs: 1,
      onRetry: (kind) => {
        retries[kind] += 1;
      },
      ...options.retry,
    },
  });
  return { memory, faults, writes, retries, db: engine.database(module) };
};

const failOnce = (failedOp: number) => {
  let used = false;
  return (): WriteResult | undefined => {
    if (used) return undefined;
    used = true;
    return { ok: false, failedOp };
  };
};

const sketchOf = (...ids: string[]) =>
  ids.reduce<string | null>((sketch, id) => addDistinct(sketch, id), null)!;

describe("engine aggregates", () => {
  it("keeps shards on a stable FNV-1a hash", () => {
    expect(shardOf("a", 2 ** 32)).toBe(0xe40c292c);
    expect(shardOf("foobar", 2 ** 32)).toBe(0xbf9cf968);
    expect(shardOf("install-1", 64)).toBe(50);
  });

  it("counts with blind increments that create the row, one op per shard row", async () => {
    const { db, writes, memory } = await setup();
    await db.transaction(async (tx) => {
      tx.aggregate("overview", { bucket: 1 }, { events: 2 }, { shardBy: "a" });
      tx.aggregate(
        "overview",
        { bucket: 1 },
        { events: 1, failures: 1 },
        { shardBy: "a" },
      );
    });
    const key = [1, shardOf("a", 4)];
    expect(writes).toEqual([
      [
        expect.objectContaining({
          type: "increment",
          key,
          by: { events: 3, failures: 1 },
        }),
      ],
    ]);
    expect(writes[0]![0]).not.toHaveProperty("guard");
    await db.transaction(async (tx) => {
      tx.aggregate("overview", { bucket: 1 }, { events: 4 }, { shardBy: "a" });
      tx.aggregate("overview", { bucket: 1 }, { events: 5 }, { shardBy: "b" });
    });
    const [row] = await memory.get(table("overview"), [key]);
    expect(row).toMatchObject({ events: 7, failures: 1, _v: 2 });
    await expect(
      db.findAggregates("overview", { index: "all", where: {}, limit: 10 }),
    ).resolves.toEqual({ rows: [{ bucket: 1, events: 12, failures: 1 }] });
  });

  it("pages a sharded aggregate newest first, each row once and whole, across pages that cut rows", async () => {
    const { db } = await setup();
    // One shardBy value per shard of `overview`'s 4.
    const shardKeys = ["a", "b", "c", "d", "e", "f", "g", "h"]
      .filter(
        (value, index, values) =>
          values.findIndex(
            (other) => shardOf(other, 4) === shardOf(value, 4),
          ) === index,
      )
      .slice(0, 4);
    expect(shardKeys.map((value) => shardOf(value, 4)).toSorted()).toEqual([
      0, 1, 2, 3,
    ]);
    await db.transaction(async (tx) => {
      for (let bucket = 1; bucket <= 10; bucket += 1) {
        // Bucket n on n % 4 + 1 shards, so pages cut rows of every width.
        for (const shardBy of shardKeys.slice(0, (bucket % 4) + 1)) {
          tx.aggregate("overview", { bucket }, { events: bucket }, { shardBy });
        }
      }
    });
    const read = (cursor?: string) =>
      db.findAggregates("overview", {
        index: "all",
        where: {},
        range: { gte: 2, lt: 10 },
        order: "desc",
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
    const rows: { bucket: number; events: number }[] = [];
    let page = await read();
    let pages = 1;
    rows.push(...page.rows);
    while (page.next !== undefined) {
      page = await read(page.next);
      pages += 1;
      rows.push(...page.rows);
    }
    expect(pages).toBeGreaterThan(3);
    expect(rows.map(({ bucket, events }) => [bucket, events])).toEqual(
      [9, 8, 7, 6, 5, 4, 3, 2].map((bucket) => [
        bucket,
        bucket * ((bucket % 4) + 1),
      ]),
    );
  });

  it("reads, merges, and writes back gauges per shard, deleting a row at zero", async () => {
    const { db, writes } = await setup();
    const change = (id: string, release: string, installations: number) =>
      db.transaction(async (tx) => {
        tx.aggregate(
          "distribution",
          { release, bucket: 1 },
          { installations },
          { shardBy: id },
        );
      });
    await change("i1", "A", 1);
    await change("i2", "A", 1);
    await change("i1", "A", -1);
    expect(writes.map((ops) => ops.map(({ type }) => type))).toEqual([
      ["insert"],
      ["insert"],
      ["delete"],
    ]);
    await expect(
      db.findAggregates("distribution", {
        index: "byRelease",
        where: { release: "A" },
        limit: 64,
      }),
    ).resolves.toEqual({
      rows: [{ release: "A", bucket: 1, installations: 1 }],
    });

    await expect(change("i1", "A", -1)).rejects.toThrow("a gauge went below 0");
    await expect(
      db.transaction(async (tx) => {
        tx.aggregate(
          "distribution",
          { release: "A", bucket: 1 },
          { installations: 1 },
        );
      }),
    ).rejects.toThrow("gauges of a sharded aggregate need shardBy");
  });

  it("reruns when another writer moved a gauge after this transaction read its head", async () => {
    const memory = createMemoryAdapter();
    await memory.migrations?.apply(schema.tables);
    const gauge = table("distribution");
    let hold: Promise<void> | undefined;
    const adapter: DatabaseAdapter = {
      ...memory,
      async get(physical, keys) {
        if (physical.name === gauge.name && hold !== undefined) {
          const wait = hold;
          hold = undefined;
          await wait;
        }
        return memory.get(physical, keys);
      },
    };
    let reruns = 0;
    const db = createDatabaseEngine({
      adapter,
      schema,
      retry: {
        baseDelayMs: 0,
        maxDelayMs: 1,
        onRetry: (kind) => {
          if (kind === "rerun") reruns += 1;
        },
      },
    }).database(module);
    const move = (release: string) =>
      db.transaction(async (tx) => {
        const head = await tx.findOne("installs", { id: "i1" });
        if (head === null) {
          tx.create("installs", { id: "i1", release });
        } else {
          tx.update("installs", head, { release });
          tx.aggregate(
            "distribution",
            { release: head.release, bucket: 1 },
            { installations: -1 },
            { shardBy: "i1" },
          );
        }
        tx.aggregate(
          "distribution",
          { release, bucket: 1 },
          { installations: 1 },
          { shardBy: "i1" },
        );
      });
    await move("A");
    let open!: () => void;
    hold = new Promise((resolve) => {
      open = resolve;
    });
    // Reads head A, then waits before reading the gauges it moves.
    const late = move("C");
    // Moves A to B meanwhile, so A's gauge is already at zero.
    await move("B");
    open();
    await late;
    const installations = async (release: string) =>
      (
        await db.findAggregates("distribution", {
          index: "byRelease",
          where: { release },
          limit: 64,
        })
      ).rows.map((row) => row.installations);
    expect(await installations("A")).toEqual([]);
    expect(await installations("B")).toEqual([]);
    expect(await installations("C")).toEqual([1]);
    expect(reruns).toBeGreaterThan(0);
  });

  it("folds counters into the guarded write when the same row has a gauge change", async () => {
    const { db, writes } = await setup();
    const change = (values: { hits?: number; open?: number }) =>
      db.transaction(async (tx) => {
        tx.aggregate("totals", { scope: "s" }, values);
      });
    await change({ hits: 1, open: 1 });
    await change({ open: -1 });
    await change({ hits: 1 });
    expect(
      writes.map((ops) => ops.map((op) => [op.type, "guard" in op])),
    ).toEqual([[["insert", false]], [["patch", true]], [["increment", false]]]);
    await expect(
      db.findAggregates("totals", { index: "all", where: {}, limit: 10 }),
    ).resolves.toEqual({ rows: [{ scope: "s", hits: 2, open: 0 }] });
  });

  it("merges sketches into the stored sketch", async () => {
    const { db } = await setup();
    for (const id of ["u1", "u2", "u3", "u1"]) {
      await db.transaction(async (tx) => {
        tx.aggregate(
          "users",
          { bucket: 1 },
          { users: sketchOf(id) },
          { shardBy: id },
        );
      });
    }
    await db.transaction(async (tx) => {
      tx.aggregate(
        "users",
        { bucket: 1 },
        { users: sketchOf("u4", "u5") },
        { shardBy: "u4" },
      );
    });
    const { rows } = await db.findAggregates("users", {
      index: "all",
      where: {},
      limit: 64,
    });
    expect(rows).toHaveLength(1);
    expect(countDistinct(rows[0]!.users)).toBe(5);
  });

  it("writes nothing when a merge leaves the stored row unchanged", async () => {
    const { db, writes } = await setup();
    const add = (id: string) =>
      db.transaction(async (tx) => {
        tx.aggregate(
          "users",
          { bucket: 1 },
          { users: sketchOf(id) },
          { shardBy: "u1" },
        );
      });
    await add("u1");
    expect(writes).toHaveLength(1);
    // the sketch already counts u1, so there is nothing to write or guard
    await add("u1");
    expect(writes).toHaveLength(1);
  });

  it("resends only the aggregate rows when their guard fails", async () => {
    const { db, faults, retries } = await setup();
    await db.transaction(async (tx) => {
      tx.create("installs", { id: "i1", release: "A" });
    });
    faults.inject = failOnce(1);
    let runs = 0;
    await db.transaction(async (tx) => {
      runs += 1;
      const head = (await tx.findOne("installs", { id: "i1" }))!;
      tx.update("installs", head, { release: "B" });
      tx.aggregate(
        "distribution",
        { release: "B", bucket: 1 },
        { installations: 1 },
        { shardBy: "i1" },
      );
    });
    expect(runs).toBe(1);
    expect(retries).toEqual({ rerun: 0, resend: 1 });

    faults.inject = failOnce(0);
    await db.transaction(async (tx) => {
      runs += 1;
      const head = (await tx.findOne("installs", { id: "i1" }))!;
      tx.update("installs", head, { release: "C" });
      tx.aggregate(
        "distribution",
        { release: "B", bucket: 1 },
        { installations: -1 },
        { shardBy: "i1" },
      );
    });
    expect(runs).toBe(3);
    expect(retries).toEqual({ rerun: 1, resend: 1 });
    await expect(
      db.findAggregates("distribution", {
        index: "byRelease",
        where: { release: "B" },
        limit: 64,
      }),
    ).resolves.toEqual({ rows: [] });
  });

  it("lets 32 writers on one hot shard row finish by resending, never rerunning fn", async () => {
    const { db, retries } = await setup({
      retry: { attempts: 64, baseDelayMs: 1, maxDelayMs: 4 },
    });
    let runs = 0;
    await Promise.all(
      Array.from({ length: 32 }, () =>
        db.transaction(async (tx) => {
          runs += 1;
          tx.aggregate(
            "distribution",
            { release: "A", bucket: 1 },
            { installations: 1 },
            { shardBy: "hot" },
          );
        }),
      ),
    );
    expect(runs).toBe(32);
    expect(retries.rerun).toBe(0);
    expect(retries.resend).toBeGreaterThan(0);
    await expect(
      db.findAggregates("distribution", {
        index: "byRelease",
        where: { release: "A" },
        limit: 64,
      }),
    ).resolves.toEqual({
      rows: [{ release: "A", bucket: 1, installations: 32 }],
    });
  });

  it("resends past its attempts while other writers keep committing its aggregate rows", async () => {
    const { db, faults, retries } = await setup({ retry: { attempts: 3 } });
    const add = () =>
      db.transaction(async (tx) => {
        tx.aggregate(
          "distribution",
          { release: "A", bucket: 1 },
          { installations: 1 },
          { shardBy: "hot" },
        );
      });
    // Another writer commits the same shard row before each of 10 writes.
    let commits = 10;
    faults.before = async () => {
      if (commits === 0) return;
      commits -= 1;
      const before = faults.before;
      faults.before = undefined;
      await add();
      faults.before = before;
    };
    let runs = 0;
    await db.transaction(async (tx) => {
      runs += 1;
      tx.aggregate(
        "distribution",
        { release: "A", bucket: 1 },
        { installations: 1 },
        { shardBy: "hot" },
      );
    });
    expect(runs).toBe(1);
    expect(retries).toEqual({ rerun: 0, resend: 10 });
    await expect(
      db.findAggregates("distribution", {
        index: "byRelease",
        where: { release: "A" },
        limit: 64,
      }),
    ).resolves.toEqual({
      rows: [{ release: "A", bucket: 1, installations: 11 }],
    });
  });

  it("stops at its attempts when a resend finds its aggregate rows unchanged", async () => {
    const add = (db: Awaited<ReturnType<typeof setup>>["db"]) =>
      db.transaction(async (tx) => {
        tx.aggregate(
          "distribution",
          { release: "A", bucket: 1 },
          { installations: 1 },
          { shardBy: "hot" },
        );
      });
    for (const fault of [
      { ok: false, retry: true },
      { ok: false, failedOp: 0 },
    ] as const) {
      const { db, faults, writes } = await setup({ retry: { attempts: 3 } });
      faults.inject = () => fault;
      await expect(add(db), JSON.stringify(fault)).rejects.toThrow(
        DatabaseConflictError,
      );
      expect(writes, JSON.stringify(fault)).toHaveLength(3);
    }
  });

  it("stops at its attempts on transient failures while other writers commit its aggregate rows", async () => {
    const { db, faults } = await setup({ retry: { attempts: 3 } });
    const add = () =>
      db.transaction(async (tx) => {
        tx.aggregate(
          "distribution",
          { release: "A", bucket: 1 },
          { installations: 1 },
          { shardBy: "hot" },
        );
      });
    const transient = () => ({ ok: false, retry: true }) as const;
    // Before each write, another writer commits the same shard row; then the
    // write itself fails transiently, naming no row.
    let commits = 0;
    faults.before = async () => {
      const before = faults.before;
      faults.before = undefined;
      faults.inject = undefined;
      await add();
      commits += 1;
      faults.inject = transient;
      faults.before = before;
    };
    faults.inject = transient;
    await expect(add()).rejects.toThrow(DatabaseConflictError);
    expect(commits).toBe(3);
  });

  it("rejects unknown aggregates, identities, metrics, and fractional deltas", async () => {
    const { db } = await setup();
    await expect(
      db.transaction(async (tx) => {
        // @ts-expect-error installs is a table.
        tx.aggregate("installs", { id: "i" }, {});
      }),
    ).rejects.toThrow(DatabaseQueryError);
    await expect(
      db.transaction(async (tx) => {
        // @ts-expect-error bucket is missing.
        tx.aggregate("overview", {}, { events: 1 });
      }),
    ).rejects.toThrow("aggregate takes exactly its identity fields: bucket");
    await expect(
      db.transaction(async (tx) => {
        // @ts-expect-error nope is not a metric.
        tx.aggregate("overview", { bucket: 1 }, { nope: 1 });
      }),
    ).rejects.toThrow("nope is not a counter, gauge, or sketch");
    await expect(
      db.transaction(async (tx) => {
        tx.aggregate("overview", { bucket: 1 }, { events: 1.5 });
      }),
    ).rejects.toThrow(DatabaseTransactionError);
  });

  it(
    "stays within B3's contention budget on a rollout from A to B with 5 ms latency",
    { timeout: 30_000 },
    async () => {
      const seeded = await setup();
      const move = (target: typeof seeded.db, index: number, release: string) =>
        target.transaction(async (tx) => {
          const id = `install-${index}`;
          const head = await tx.findOne("installs", { id });
          if (head === null) {
            tx.create("installs", { id, release });
          } else {
            tx.update("installs", head, { release });
            tx.aggregate(
              "distribution",
              { release: head.release, bucket: 1 },
              { installations: -1 },
              { shardBy: id },
            );
          }
          tx.aggregate(
            "distribution",
            { release, bucket: 1 },
            { installations: 1 },
            { shardBy: id },
          );
          tx.aggregate(
            "overview",
            { bucket: 1 },
            { events: 1 },
            { shardBy: id },
          );
          tx.aggregate(
            "users",
            { bucket: 1 },
            { users: sketchOf(id) },
            { shardBy: id },
          );
        });
      for (let index = 0; index < 300; index += 1) {
        await move(seeded.db, index, "A");
      }
      const slow = createDatabaseEngine({
        adapter: withAdapterLatency(seeded.memory, 5),
        schema,
        retry: {
          onRetry: (kind) => {
            seeded.retries[kind] += 1;
          },
        },
      }).database(module);
      seeded.retries.rerun = 0;
      seeded.retries.resend = 0;
      const report = await runContentionHarness({
        transactions: 300,
        ratePerSecond: 100,
        concurrency: 16,
        run: (index) => move(slow, index, "B"),
      });
      expect(report.errors).toEqual({});
      expect(report.committed).toBe(300);
      const retried = seeded.retries.rerun + seeded.retries.resend;
      expect(retried / report.transactions).toBeLessThanOrEqual(0.05);

      const read = (release: string) =>
        seeded.db.findAggregates("distribution", {
          index: "byRelease",
          where: { release },
          limit: 100,
        });
      await expect(read("A")).resolves.toEqual({ rows: [] });
      await expect(read("B")).resolves.toEqual({
        rows: [{ release: "B", bucket: 1, installations: 300 }],
      });
      await expect(
        seeded.db.findAggregates("overview", {
          index: "all",
          where: {},
          limit: 10,
        }),
      ).resolves.toEqual({ rows: [{ bucket: 1, events: 600, failures: 0 }] });
      const { rows } = await seeded.db.findAggregates("users", {
        index: "all",
        where: {},
        limit: 64,
      });
      const ids = Array.from({ length: 300 }, (_, index) => `install-${index}`);
      expect(rows[0]!.users).toBe(sketchOf(...ids));
    },
  );
});
