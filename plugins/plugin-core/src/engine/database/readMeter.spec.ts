import { describe, expect, it } from "vitest";

import { createMemoryAdapter } from "../../database/memoryAdapter";
import { defineTable } from "../../serverPlugin/schema";
import { createEngine } from "../createEngine";
import { createEngineDatabase, migrateCoreSchema } from "../db/coreDatabase";
import { meterReads, readMeterOf } from "./readMeter";

const notes = {
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable(
      { id: { type: "string", maxLength: 8 }, at: { type: "integer" } },
      { key: ["id"], indexes: { byTime: { eq: [], sort: ["at"] } } },
    ),
  },
} as const;

describe("meterReads", () => {
  it("counts what every engine on the database reads at the adapter and returns", async () => {
    const database = meterReads({
      name: "memory",
      adapter: createMemoryAdapter(),
    });
    const first = createEngine(database, { plugins: [notes] });
    const second = createEngine(database, { plugins: [notes] });
    await first.database(notes).transaction(async (tx) => {
      tx.create("notes", { id: "a", at: 1 });
      tx.create("notes", { id: "b", at: 2 });
    });

    const measured = await database.measureReads(async () => [
      await first.database(notes).findOne("notes", { id: "a" }),
      await second
        .database(notes)
        .findMany("notes", { index: "byTime", where: {}, limit: 5 }),
    ]);

    expect(measured.adapter).toEqual({ gets: 1, keys: 1, queries: 1, rows: 2 });
    expect(measured.engine).toEqual({ calls: 2, rows: 3 });
    // A later measurement starts from nothing.
    await expect(
      database.measureReads(async () => undefined),
    ).resolves.toMatchObject({
      adapter: { gets: 0, keys: 0, queries: 0, rows: 0 },
      engine: { calls: 0, rows: 0 },
    });
  });

  it("leaves the schema fence's read out of every call", async () => {
    const adapter = createMemoryAdapter();
    await migrateCoreSchema(adapter, "memory", [notes]);
    const database = meterReads(
      createEngineDatabase({ name: "memory", adapter }),
    );
    const engine = createEngine(database, { plugins: [notes] });

    // The first read checks core's settings and the plugin's, then reads.
    const measured = await database.measureReads(() =>
      engine.database(notes).findOne("notes", { id: "a" }),
    );

    expect(measured).toEqual({
      result: null,
      adapter: { gets: 1, keys: 1, queries: 0, rows: 0 },
      engine: { calls: 1, rows: 0 },
    });
  });

  it("gives a database without it no meter", () => {
    const database = { name: "memory", adapter: createMemoryAdapter() };

    expect(readMeterOf(database)).toBeUndefined();
    expect("measureReads" in database).toBe(false);
    expect(readMeterOf(meterReads(database))).toBeDefined();
  });
});
