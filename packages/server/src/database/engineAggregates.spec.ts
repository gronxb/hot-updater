import {
  addInsightsDistinct,
  countInsightsDistinct,
  createMemoryAdapter,
  type DatabaseAdapter,
  type WriteOp,
  type WriteResult,
} from "@hot-updater/plugin-core/internal";
import {
  runContentionHarness,
  withAdapterLatency,
} from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createDatabaseEngine } from "./database";
import { shardOf } from "./engineAggregates";
import { DatabaseQueryError } from "./engineReads";
import type { RetryOptions } from "./engineTransaction";
import { DatabaseTransactionError } from "./errors";
import { resolveSchema } from "./resolveSchema";
import { defineAggregate, defineTable } from "./schema";

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
  const faults: { inject?: () => WriteResult | undefined } = {};
  const writes: (readonly WriteOp[])[] = [];
  const retries = { rerun: 0, resend: 0 };
  const faulty: DatabaseAdapter = {
    ...memory,
    async write(ops) {
      writes.push(ops);
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
  ids.reduce<string | null>(
    (sketch, id) => addInsightsDistinct(sketch, id),
    null,
  )!;

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
    expect(countInsightsDistinct(rows[0]!.users)).toBe(5);
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
