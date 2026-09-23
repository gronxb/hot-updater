import {
  createMemoryAdapter,
  type StoredRow,
} from "@hot-updater/plugin-core/internal";
import { beforeEach, describe, expect, it } from "vitest";

import { DatabaseCursorError } from "./cursor";
import { createDatabaseEngine } from "./database";
import { DatabaseQueryError } from "./engineReads";
import { resolveSchema } from "./resolveSchema";
import { defineAggregate, defineTable } from "./schema";

const bundles = defineTable(
  {
    id: { type: "string", maxLength: 36 },
    platform: { type: "string", maxLength: 16 },
    hash: { type: "string", unique: true },
  },
  {
    key: ["id"],
    indexes: {
      all: { eq: [], sort: ["id"] },
      byPlatform: { eq: ["platform"], sort: ["id"] },
    },
  },
);

const totals = defineAggregate(
  { scope: { type: "string", maxLength: 32 }, bucket: { type: "integer" } },
  {
    key: ["scope", "bucket"],
    counters: ["hits"],
    shards: 3,
    indexes: { byScope: { eq: ["scope"], sort: ["bucket"] } },
  },
);

const core = { id: "core", schema: { bundles, totals } } as const;
const schema = resolveSchema([core]);

const bundle = (id: string, platform = "ios"): StoredRow => ({
  id,
  platform,
  hash: `hash-${id}`,
  _v: 0,
});

const shard = (
  bucket: number,
  shardNumber: number,
  hits: number,
): StoredRow => ({
  scope: "s",
  bucket,
  _shard: shardNumber,
  hits,
  _v: 1,
});

describe("engine reads", () => {
  let engine: ReturnType<typeof createDatabaseEngine>;
  let db: ReturnType<typeof engine.database<typeof core.schema>>;

  beforeEach(async () => {
    const adapter = createMemoryAdapter();
    await adapter.migrations?.apply(schema.tables);
    await adapter.write([
      ...["b1", "b2", "b3", "b4", "b5"].map((id) => ({
        type: "insert" as const,
        table: schema.models.get("bundles")!.table,
        row: bundle(id, id === "b3" ? "android" : "ios"),
      })),
      ...[
        shard(1, 0, 1),
        shard(1, 2, 2),
        shard(2, 0, 3),
        shard(2, 1, 4),
        shard(2, 2, 5),
        shard(3, 1, 6),
      ].map((row) => ({
        type: "insert" as const,
        table: schema.models.get("totals")!.table,
        row,
      })),
    ]);
    engine = createDatabaseEngine({
      adapter,
      schema,
      verify: true,
      maxPageSize: 100,
    });
    db = engine.database(core);
  });

  it("reads one row by key or by a unique field, never by another field", async () => {
    await expect(db.findOne("bundles", { id: "b2" })).resolves.toMatchObject({
      id: "b2",
    });
    await expect(
      db.findOne("bundles", { hash: "hash-b4" }),
    ).resolves.toMatchObject({
      id: "b4",
    });
    await expect(db.findOne("bundles", { id: "missing" })).resolves.toBeNull();
    await expect(
      // @ts-expect-error platform is neither the key nor unique.
      db.findOne("bundles", { platform: "ios" }),
    ).rejects.toThrow(DatabaseQueryError);
  });

  it("pages an index with bound cursors and returns next only after a full page", async () => {
    const first = await db.findMany("bundles", {
      index: "byPlatform",
      where: { platform: "ios" },
      limit: 2,
    });
    expect(first.rows.map((row) => row.id)).toEqual(["b1", "b2"]);
    const second = await db.findMany("bundles", {
      index: "byPlatform",
      where: { platform: "ios" },
      limit: 2,
      cursor: first.next,
    });
    expect(second.rows.map((row) => row.id)).toEqual(["b4", "b5"]);
    const last = await db.findMany("bundles", {
      index: "byPlatform",
      where: { platform: "ios" },
      limit: 2,
      cursor: second.next,
    });
    expect(last).toEqual({ rows: [] });

    const partial = await db.findMany("bundles", {
      index: "all",
      where: {},
      range: { gt: "b1", lte: "b3" },
      order: "desc",
      limit: 5,
    });
    expect(partial.rows.map((row) => row.id)).toEqual(["b3", "b2"]);
    expect(partial.next).toBeUndefined();
  });

  it("rejects a cursor from another read, a missing eq field, and oversized pages", async () => {
    const page = await db.findMany("bundles", {
      index: "byPlatform",
      where: { platform: "ios" },
      limit: 1,
    });
    await expect(
      db.findMany("bundles", {
        index: "byPlatform",
        where: { platform: "android" },
        limit: 1,
        cursor: page.next,
      }),
    ).rejects.toThrow(DatabaseCursorError);
    await expect(
      // @ts-expect-error byPlatform needs its platform eq field.
      db.findMany("bundles", { index: "byPlatform", where: {}, limit: 1 }),
    ).rejects.toThrow("need where on exactly: platform");
    await expect(
      db.findMany("bundles", { index: "all", where: {}, limit: 101 }),
    ).rejects.toThrow("limit must be 1–100");
  });

  it("merges shards and completes a logical row cut off by the limit", async () => {
    const measured = await engine.measureReads(() =>
      db.findAggregates("totals", {
        index: "byScope",
        where: { scope: "s" },
        limit: 4,
      }),
    );
    expect(measured.result.rows).toEqual([
      { scope: "s", bucket: 1, hits: 3 },
      { scope: "s", bucket: 2, hits: 12 },
    ]);
    expect(measured.adapter).toEqual({ gets: 1, keys: 1, queries: 1, rows: 4 });
    expect(measured.engine).toEqual({ calls: 1, rows: 2 });

    const rest = await db.findAggregates("totals", {
      index: "byScope",
      where: { scope: "s" },
      limit: 4,
      cursor: measured.result.next,
    });
    expect(rest).toEqual({ rows: [{ scope: "s", bucket: 3, hits: 6 }] });
  });

  it("returns exactly the rows it reads", async () => {
    const one = await engine.measureReads(() =>
      db.findOne("bundles", { id: "b1" }),
    );
    expect(one.adapter).toEqual({ gets: 1, keys: 1, queries: 0, rows: 0 });
    expect(one.engine).toEqual({ calls: 1, rows: 1 });

    const many = await engine.measureReads(() =>
      db.findMany("bundles", { index: "all", where: {}, limit: 3 }),
    );
    expect(many.adapter.rows).toBe(many.engine.rows);
    expect(many.engine.rows).toBe(3);
  });

  it("reads tables with findMany and aggregates with findAggregates only", async () => {
    await expect(
      // @ts-expect-error totals is an aggregate.
      db.findMany("totals", {
        index: "byScope",
        where: { scope: "s" },
        limit: 1,
      }),
    ).rejects.toThrow("read it with findAggregates");
    await expect(
      // @ts-expect-error bundles is a table.
      db.findAggregates("bundles", { index: "all", where: {}, limit: 1 }),
    ).rejects.toThrow("read it with findMany");
  });
});
