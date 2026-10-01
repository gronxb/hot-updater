import { describe, expect, it, vi } from "vitest";

import {
  DatabaseSchemaError,
  expiresAt,
  type PhysicalTable,
} from "../../database/adapter";
import { createMemoryAdapter } from "../../database/memoryAdapter";
import { createDatabaseEngine } from "./database";
import { NegativeGaugeError } from "./engineAggregates";
import { resolveSchema, type SchemaModule } from "./resolveSchema";
import { pruneDuringWrites } from "./retention";
import { defineAggregate, defineTable, type ModuleSchema } from "./schema";

const DAY = 86_400_000;

const events = defineTable(
  {
    id: { type: "string", maxLength: 36 },
    received_at_ms: { type: "integer" },
  },
  {
    key: ["id"],
    derived: {
      day: {
        type: "integer",
        compute: (row) => row.received_at_ms - (row.received_at_ms % DAY),
      },
    },
    indexes: { byDay: { eq: ["day"], sort: ["received_at_ms"] } },
    retention: { field: "day", days: 90 },
  },
);

/** Installations counted in the day of their latest event. */
const latest = defineAggregate(
  { release: { type: "string", maxLength: 16 }, bucket: { type: "integer" } },
  {
    key: ["release", "bucket"],
    gauges: ["installations"],
    shards: 4,
    indexes: { byRelease: { eq: ["release"], sort: ["bucket"] } },
    retention: { field: "bucket", days: 400 },
  },
);

const kept = defineTable(
  { id: { type: "string", maxLength: 36 } },
  { key: ["id"] },
);

const module = <S extends ModuleSchema>(schema: S) => ({
  id: "retention",
  schema,
});

const invalid = (schema: SchemaModule["schema"]) => () =>
  resolveSchema([{ id: "retention", schema }]);

describe("retention", () => {
  it("maps a model's retention onto its physical table", () => {
    const { models } = resolveSchema([module({ events, latest, kept })]);

    expect(models.get("events")!.table.retention).toEqual({
      column: "day",
      ms: 90 * DAY,
    });
    expect(models.get("latest")!.table.retention).toEqual({
      column: "bucket",
      ms: 400 * DAY,
    });
    expect(models.get("kept")!.table).not.toHaveProperty("retention");
    expect(expiresAt(models.get("events")!.table, { day: 10 * DAY })).toBe(
      100 * DAY,
    );
    expect(expiresAt(models.get("events")!.table, { day: null })).toBe(
      undefined,
    );
  });

  it("rejects retention on a field that holds no integer, or over no whole days", () => {
    const table = (retention: { field: string; days: number }) =>
      ({ ...kept, retention }) as unknown as typeof kept;

    expect(invalid({ kept: table({ field: "id", days: 1 }) })).toThrow(
      'retention.kept: retention field "id" is not an integer field',
    );
    expect(invalid({ kept: table({ field: "missing", days: 1 }) })).toThrow(
      'retention field "missing" is not an integer field',
    );
    expect(
      invalid({
        events: { ...events, retention: { field: "day", days: 0.5 } },
      }),
    ).toThrow("retention days must be a whole number of at least 1");
    expect(
      invalid({ events: { ...events, retention: { field: "day", days: 0 } } }),
    ).toThrow(DatabaseSchemaError);
  });

  it("rejects retention on a model in a reference or a rooted index", () => {
    const parent = defineTable(
      {
        id: { type: "string", maxLength: 36 },
        at: { type: "integer" },
      },
      { key: ["id"], retention: { field: "at", days: 1 } },
    );
    const child = defineTable(
      {
        id: { type: "string", maxLength: 36 },
        parent: {
          type: "string",
          maxLength: 36,
          references: { model: "parent", onDelete: "cascade" },
        },
      },
      {
        key: ["id"],
        indexes: {
          byParent: {
            eq: ["parent"],
            sort: [],
            root: { model: "parent" },
          },
        },
      },
    );

    expect(invalid({ parent, child })).toThrow(
      "retention.parent: a model with retention is in no reference or rooted index",
    );
  });

  const lease: PhysicalTable = {
    name: "settings",
    columns: [
      { name: "key", type: "string", nullable: false, maxLength: 255 },
      { name: "value", type: "string", nullable: false, maxLength: 255 },
      { name: "_v", type: "integer", nullable: false, default: 0 },
    ],
    key: ["key"],
    indexes: [],
  };

  it("prunes after writes only where rows expire and the backend keeps them", () => {
    const adapter = createMemoryAdapter();
    const { prune: _prune, ...native } = adapter;
    const options = { leaseTable: lease, now: () => 0 };

    const expiring = resolveSchema([module({ events })]).tables;
    expect(pruneDuringWrites(native, expiring, options)).toBe(native);
    const kepts = resolveSchema([module({ kept })]).tables;
    expect(pruneDuringWrites(adapter, kepts, options)).toBe(adapter);
  });

  it("prunes again in a minute while a pass finds a full batch, else in an hour", async () => {
    const { tables } = resolveSchema([module({ events })]);
    const memory = createMemoryAdapter();
    const prune = vi.fn(async () => 500);
    let now = 100 * DAY;
    const adapter = pruneDuringWrites({ ...memory, prune }, tables, {
      leaseTable: lease,
      now: () => now,
    });
    const writeAt = async (ms: number) => {
      now += ms;
      expect(await adapter.write([])).toEqual({ ok: true });
    };

    await writeAt(0);
    await writeAt(30_000);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune.mock.calls[0]).toEqual([tables[0], 10 * DAY, 500]);
    await writeAt(31_000);
    expect(prune).toHaveBeenCalledTimes(2);

    prune.mockResolvedValue(3);
    await writeAt(61_000);
    await writeAt(30 * 60_000);
    expect(prune).toHaveBeenCalledTimes(3);
    await writeAt(31 * 60_000);
    expect(prune).toHaveBeenCalledTimes(4);
    const [row] = await memory.get(lease, [["retention.nextPassAt"]]);
    expect(row).toMatchObject({ value: String(now + 3_600_000) });
  });

  it("writes even when its pass fails", async () => {
    const { tables } = resolveSchema([module({ events })]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = pruneDuringWrites(
      {
        ...createMemoryAdapter(),
        prune: async () => Promise.reject(new Error("down")),
      },
      tables,
      { leaseTable: lease, now: () => 100 * DAY },
    );

    await expect(adapter.write([])).resolves.toEqual({ ok: true });
    expect(warn).toHaveBeenCalledWith(
      "[hot-updater] Pruning expired rows failed.",
      expect.objectContaining({ message: "down" }),
    );
    warn.mockRestore();
  });

  it("prunes each table with retention as of the write, and nothing else", async () => {
    const { tables } = resolveSchema([module({ events, latest, kept })]);
    const prune = vi.fn(
      async (_table: PhysicalTable, _before: number, _limit: number) => 2,
    );
    const adapter = pruneDuringWrites(
      { ...createMemoryAdapter(), prune },
      tables,
      { leaseTable: lease, now: () => 1_000 * DAY },
    );

    await adapter.write([]);

    expect(
      prune.mock.calls.map(([table, before, limit]) => [
        table.name,
        before,
        limit,
      ]),
    ).toEqual([
      ["events", 910 * DAY, 500],
      ["latest", 600 * DAY, 500],
    ]);
  });

  it("deletes expired rows on the reference adapter, and keeps the rest", async () => {
    const schema = resolveSchema([module({ events, kept })]);
    let now = 100 * DAY;
    const adapter = pruneDuringWrites(createMemoryAdapter(), schema.tables, {
      leaseTable: lease,
      now: () => now,
    });
    const db = createDatabaseEngine({ adapter, schema }).database(
      module({ events, kept }),
    );

    // The write that takes the lease prunes before it stores its rows.
    await db.transaction(async (tx) => {
      tx.create("events", { id: "old", received_at_ms: 1 * DAY + 5 });
      tx.create("events", { id: "new", received_at_ms: 95 * DAY });
      tx.create("kept", { id: "kept" });
    });
    expect(await db.findOne("events", { id: "old" })).not.toBeNull();

    // Day 1 expires at day 91; day 95 at day 185. The next pass is due in an hour.
    now += 3_600_000;
    await db.transaction(async (tx) => {
      tx.create("kept", { id: "later" });
    });
    expect(await db.findOne("events", { id: "old" })).toBeNull();
    expect(await db.findOne("events", { id: "new" })).not.toBeNull();
    expect(await db.findOne("kept", { id: "kept" })).not.toBeNull();
  });

  it("drops a gauge decrement of a row retention already deleted", async () => {
    const schema = resolveSchema([module({ latest })]);
    const adapter = createMemoryAdapter();
    const db = createDatabaseEngine({ adapter, schema }).database(
      module({ latest }),
    );
    const move = (bucket: number, installations: number) =>
      db.transaction(async (tx) => {
        tx.aggregate(
          "latest",
          { release: "r1", bucket },
          { installations },
          { shardBy: "install-1" },
        );
      });
    await move(1, 1);
    await adapter.prune!(schema.tables[0]!, 600 * DAY, 10);

    // The installation's day was pruned; its move out of it changes nothing.
    await move(1, -1);
    await move(900 * DAY, 1);

    const rows = await db.findAggregates("latest", {
      index: "byRelease",
      where: { release: "r1" },
      limit: 10,
    });
    expect(rows.rows).toEqual([
      { release: "r1", bucket: 900 * DAY, installations: 1 },
    ]);
  });

  it("still refuses a gauge below zero on a model without retention", async () => {
    const { retention: _retention, ...forever } = latest;
    const schema = resolveSchema([module({ latest: forever })]);
    const db = createDatabaseEngine({
      adapter: createMemoryAdapter(),
      schema,
      retry: { attempts: 2, baseDelayMs: 0 },
    }).database(module({ latest: forever }));

    await expect(
      db.transaction(async (tx) => {
        tx.aggregate(
          "latest",
          { release: "r1", bucket: 1 },
          { installations: -1 },
          { shardBy: "install-1" },
        );
      }),
    ).rejects.toThrow(NegativeGaugeError);
  });
});
