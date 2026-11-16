import { describe, expect, it } from "vitest";

import type { DatabaseAdapter, WriteOp } from "../../database/adapter";
import { createMemoryAdapter } from "../../database/memoryAdapter";
import { createDatabaseEngine } from "./database";
import { DatabaseTransactionError } from "./errors";
import { SETTINGS_TABLE } from "./fence";
import { resolveSchema } from "./resolveSchema";
import { defineTable } from "./schema";

const rows = defineTable(
  {
    id: { type: "string", maxLength: 8 },
    value: { type: "string", maxLength: 8 },
  },
  { key: ["id"] },
);

const schema = { rows };
const module = { id: "test", schema } as never;

/** The memory adapter, its gets and writes counted, with an op limit for `fits`. */
const setup = ({ maxOps = 100 } = {}) => {
  const memory = createMemoryAdapter();
  const calls = { gets: 0, writes: 0 };
  const adapter: DatabaseAdapter = Object.assign(
    Object.create(memory) as DatabaseAdapter,
    {
      fits: (ops: readonly WriteOp[]) => ops.length <= maxOps,
      get: (...args: Parameters<DatabaseAdapter["get"]>) => {
        calls.gets += 1;
        return memory.get(...args);
      },
      write: (ops: readonly WriteOp[]) => {
        calls.writes += 1;
        return memory.write(ops);
      },
    },
  );
  const resolved = resolveSchema([module]);
  const engine = createDatabaseEngine({ adapter, schema: resolved });
  const db = engine.database(module) as ReturnType<
    typeof engine.database<typeof schema>
  >;
  return { adapter, calls, db, memory, resolved };
};

const seed = async (db: ReturnType<typeof setup>["db"], ids: string[]) => {
  await db.transaction(async (tx) => {
    for (const id of ids) tx.create("rows", { id, value: "v0" });
  });
};

describe("core's catalog write support on the engine", () => {
  it("fits compiles a transaction against the adapter's fits and never writes", async () => {
    const { calls, db } = setup({ maxOps: 2 });
    const before = calls.writes;
    await expect(
      db.fits(async (tx) => {
        tx.create("rows", { id: "a", value: "v" });
        tx.create("rows", { id: "b", value: "v" });
      }),
    ).resolves.toBe(true);
    await expect(
      db.fits(async (tx) => {
        for (const id of ["a", "b", "c"]) tx.create("rows", { id, value: "v" });
      }),
    ).resolves.toBe(false);
    expect(calls.writes).toBe(before);
    expect(await db.findOne("rows", { id: "a" })).toBeNull();
  });

  it("findByKeysIn reads many rows in one adapter call, missing keys as null", async () => {
    const { calls, db } = setup();
    await seed(db, ["a", "b", "c"]);
    calls.gets = 0;
    await db.transaction(async (tx) => {
      const found = await db.findByKeysIn(tx, "rows", [
        { id: "a" },
        { id: "b" },
        { id: "missing" },
      ]);
      expect(found.map((row) => row?.id ?? null)).toEqual(["a", "b", null]);
      for (const row of found) {
        if (row !== null) tx.update("rows", row, { value: "v1" });
      }
    });
    expect(calls.gets).toBe(1);
    expect((await db.findOne("rows", { id: "b" }))?.value).toBe("v1");
  });

  it("a row findByKeysIn read, changed by another writer before the commit, reruns the transaction", async () => {
    const { db, memory, resolved } = setup();
    await seed(db, ["a"]);
    const table = [...resolved.models.values()].find(({ table }) =>
      table.name.endsWith("rows"),
    )!.table;
    let runs = 0;
    await db.transaction(async (tx) => {
      runs += 1;
      const [row] = await db.findByKeysIn(tx, "rows", [{ id: "a" }]);
      if (runs === 1) {
        const [current] = await memory.get(table, [["a"]]);
        await memory.write([
          {
            type: "patch",
            table,
            key: ["a"],
            set: { value: "other" },
            guard: { v: Number(current!._v) },
            previous: current!,
          },
        ]);
      }
      tx.update("rows", row!, { value: `run${runs}` });
    });
    expect(runs).toBe(2);
    expect((await db.findOne("rows", { id: "a" }))?.value).toBe("run2");
  });

  it("readSetting and unguardedSnapshot read inside a transaction's callback; db reads there throw", async () => {
    const { db, memory } = setup();
    await memory.write([
      {
        type: "insert",
        table: SETTINGS_TABLE,
        row: { key: "catalog.partitioning", value: "on", _v: 0 },
      },
    ]);
    await seed(db, ["a"]);
    await db.transaction(async () => {
      expect(await db.readSetting("catalog.partitioning")).toBe("on");
      expect(await db.readSetting("absent")).toBeNull();
      const row = await db.unguardedSnapshot((reader) =>
        reader.findOne("rows", { id: "a" }),
      );
      expect(row?.value).toBe("v0");
      if (globalThis.process?.getBuiltinModule?.("node:async_hooks")) {
        expect(() => db.findOne("rows", { id: "a" })).toThrow(
          DatabaseTransactionError,
        );
      }
    });
  });
});
