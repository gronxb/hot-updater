import {
  compareTuples,
  compareUtf8,
  DatabaseAdapterContractError,
  type DatabaseKeyValue,
  type PhysicalTable,
  type StoredRow,
} from "@hot-updater/plugin-core/internal";
import { conformanceCounters, conformanceItems } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { createDatabaseEngine } from "../database";
import { resolveSchema } from "../resolveSchema";
import { defineTable } from "../schema";
import { createKvAdapter, encodeKvKey, type KeyValueStore } from "./kvAdapter";
import { createMemoryKeyValueStore } from "./kvTestStore";

const item = (id: string, values: Partial<StoredRow> = {}): StoredRow => ({
  id,
  grp: "g",
  score: 0,
  ratio: null,
  flag: false,
  label: null,
  tags: null,
  payload: null,
  note: null,
  _v: 0,
  ...values,
});

/** Records every store call, so a test can count native reads. */
const recorded = (store: KeyValueStore) => {
  const calls: string[] = [];
  return {
    calls,
    store: {
      ...store,
      get: (keys) => {
        calls.push(`get ${keys.length}`);
        return store.get(keys);
      },
      query: (range) => {
        calls.push(`query ${range.pk}`);
        return store.query(range);
      },
    } satisfies KeyValueStore,
  };
};

describe("encodeKvKey", () => {
  it("orders encoded tuples as the tuples compare, prefixes first", () => {
    const strings = [
      "",
      "a",
      "a\u0000",
      "a\u0001",
      "a\u0002",
      "a\u0003",
      "ab",
      "b",
      "é",
      "😀",
      "ﬀ",
    ];
    const numbers = [
      -Number.MAX_VALUE,
      -1.5,
      -1,
      -Number.MIN_VALUE,
      -0,
      0,
      Number.MIN_VALUE,
      1e-9,
      1,
      2,
      10,
      Number.MAX_SAFE_INTEGER,
    ];
    const tuples: DatabaseKeyValue[][] = [
      ...strings.flatMap((left) => strings.map((right) => [left, right])),
      ...strings.map((value) => [value]),
      ...numbers.map((value) => [value, true]),
      ...numbers.map((value) => [value, false]),
      ...numbers.map((value) => [value]),
    ];
    for (const left of tuples) {
      for (const right of tuples) {
        if (typeof left[0] !== typeof right[0]) continue;
        const expected = Math.sign(compareTuples(left, right));
        expect(
          Math.sign(compareUtf8(encodeKvKey(left), encodeKvKey(right))),
          JSON.stringify([left, right]),
        ).toBe(expected);
      }
    }
  });
});

describe("createKvAdapter", () => {
  it("writes a row item, an index item per entry, and a unique item", async () => {
    const store = createMemoryKeyValueStore();
    const adapter = createKvAdapter({ store });
    const row = item("a", { label: "L", tags: ["x", "y"] });

    expect(
      await adapter.write([{ type: "insert", table: conformanceItems, row }]),
    ).toEqual({ ok: true });
    // The row, byGroup, byGroupFlag, byTag for x and y, and byLabel; `all` reads the rows.
    expect(store.items()).toBe(6);
    await adapter.write([
      {
        type: "delete",
        table: conformanceItems,
        key: ["a"],
        guard: { v: 0 },
        previous: row,
      },
    ]);
    expect(store.items()).toBe(0);
  });

  it("answers a unique read with the index copy, without `_v`, in one read", async () => {
    const { store, calls } = recorded(createMemoryKeyValueStore());
    const adapter = createKvAdapter({ store });
    await adapter.write([
      {
        type: "insert",
        table: conformanceItems,
        row: item("a", { label: "L" }),
      },
    ]);

    const rows = await adapter.query(conformanceItems, {
      index: "byLabel",
      eq: ["L"],
      order: "asc",
      limit: 1,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "a", label: "L" });
    expect(rows[0]).not.toHaveProperty("_v");
    expect(calls).toEqual(["get 1"]);
  });

  it("fills counters from the rows, and returns a row that still equals its copy", async () => {
    const parent: PhysicalTable = {
      name: "parents",
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "name", type: "string", nullable: false },
        {
          name: "_refs_children_parent_id",
          type: "integer",
          nullable: false,
          default: 0,
        },
        { name: "_v", type: "integer", nullable: false, default: 0 },
      ],
      key: ["id"],
      indexes: [{ name: "byName", eq: ["name"], sort: [] }],
    };
    const adapter = createKvAdapter({ store: createMemoryKeyValueStore() });
    await adapter.write([
      {
        type: "insert",
        table: parent,
        row: { id: "p", name: "n", _refs_children_parent_id: 0, _v: 0 },
      },
    ]);
    await adapter.write([
      {
        type: "increment",
        table: parent,
        key: ["p"],
        by: { _refs_children_parent_id: 2 },
      },
    ]);

    expect(
      await adapter.query(parent, {
        index: "byName",
        eq: ["n"],
        order: "asc",
        limit: 5,
      }),
    ).toEqual([{ id: "p", name: "n", _refs_children_parent_id: 2, _v: 1 }]);
    await expect(
      adapter.write([
        { type: "increment", table: parent, key: ["p"], by: { name: 1 } },
      ]),
    ).rejects.toThrow(DatabaseAdapterContractError);
    await expect(
      adapter.write([
        {
          type: "increment",
          table: parent,
          key: ["q"],
          by: { _refs_children_parent_id: 1 },
          init: { id: "q", name: "m", _refs_children_parent_id: 0, _v: 0 },
        },
      ]),
    ).rejects.toThrow(DatabaseAdapterContractError);
  });

  it("counts index items and bytes against the store's limits", () => {
    const adapter = createKvAdapter({
      store: createMemoryKeyValueStore({ limits: { items: 6, bytes: 2_000 } }),
    });
    const insert = (row: StoredRow) =>
      ({ type: "insert", table: conformanceItems, row }) as const;

    expect(adapter.fits([insert(item("a")), insert(item("b"))])).toBe(true);
    expect(
      adapter.fits([insert(item("a")), insert(item("b")), insert(item("c"))]),
    ).toBe(false);
    expect(adapter.fits([insert(item("a", { note: "x".repeat(2_000) }))])).toBe(
      false,
    );
    const capped = createKvAdapter({
      store: createMemoryKeyValueStore({
        limits: { items: 100, bytes: 4_000, itemBytes: 1_000 },
      }),
    });
    expect(capped.fits([insert(item("a", { note: "x".repeat(900) }))])).toBe(
      false,
    );
    const keyed = createKvAdapter({
      store: createMemoryKeyValueStore({
        limits: { items: 100, bytes: 4_000, keyBytes: { pk: 200, sk: 40 } },
      }),
    });
    expect(keyed.fits([insert(item("a"))])).toBe(true);
    // A long id makes a long sort key; each copy's sort key holds it too.
    expect(keyed.fits([insert(item("i".repeat(40)))])).toBe(false);
    expect(
      adapter.fits([
        {
          type: "increment",
          table: conformanceCounters,
          key: ["c", 0],
          by: { hits: 1 },
        },
      ]),
    ).toBe(true);
  });

  it("moves a unique value from one row to another in one write", async () => {
    const adapter = createKvAdapter({ store: createMemoryKeyValueStore() });
    const a = item("a", { label: "L" });
    const b = item("b", { label: "M" });
    await adapter.write([
      { type: "insert", table: conformanceItems, row: a },
      { type: "insert", table: conformanceItems, row: b },
    ]);

    expect(
      await adapter.write([
        {
          type: "patch",
          table: conformanceItems,
          key: ["a"],
          set: { label: "M" },
          guard: { v: 0 },
          previous: a,
        },
        {
          type: "patch",
          table: conformanceItems,
          key: ["b"],
          set: { label: "L" },
          guard: { v: 0 },
          previous: b,
        },
      ]),
    ).toEqual({ ok: true });
    const byLabel = async (label: string) =>
      (
        await adapter.query(conformanceItems, {
          index: "byLabel",
          eq: [label],
          order: "asc",
          limit: 1,
        })
      ).map((row) => row.id);
    expect(await byLabel("L")).toEqual(["b"]);
    expect(await byLabel("M")).toEqual(["a"]);
    expect(
      await adapter.write([
        {
          type: "insert",
          table: conformanceItems,
          row: item("c", { label: "N" }),
        },
        {
          type: "insert",
          table: conformanceItems,
          row: item("d", { label: "N" }),
        },
      ]),
    ).toEqual({ ok: false, failedOp: 1 });
  });
});

describe("key-value ranges", () => {
  it("answers crossing bounds without asking the store", async () => {
    const { store, calls } = recorded(createMemoryKeyValueStore());
    const adapter = createKvAdapter({ store });

    expect(
      await adapter.query(conformanceItems, {
        index: "byGroup",
        eq: ["g"],
        lower: { values: [5], inclusive: false },
        upper: { values: [5], inclusive: false },
        order: "asc",
        limit: 5,
      }),
    ).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("the engine over the key-value adapter", () => {
  const keys = defineTable(
    {
      id: { type: "string", maxLength: 36 },
      hash: { type: "string", maxLength: 64, unique: true },
      note: { type: "string", required: false },
    },
    { key: ["id"] },
  );
  const module = { id: "kv", schema: { keys } } as const;
  const schema = resolveSchema([module]);
  const table = schema.models.get("keys")!.table;

  const setup = (beforeGet?: (keys: readonly { pk: string }[]) => unknown) => {
    const { store, calls } = recorded(createMemoryKeyValueStore());
    const adapter = createKvAdapter({
      store: {
        ...store,
        get: async (keys) => {
          await beforeGet?.(keys);
          return store.get(keys);
        },
      },
    });
    const db = createDatabaseEngine({ adapter, schema }).database(module);
    return { adapter, calls, db };
  };

  it("reads an index copy whole only inside a transaction", async () => {
    const { calls, db } = setup();
    await db.transaction(async (tx) => {
      tx.create("keys", { id: "k", hash: "h", note: "a" });
    });

    calls.length = 0;
    await expect(db.findOne("keys", { hash: "h" })).resolves.toEqual({
      id: "k",
      hash: "h",
      note: "a",
    });
    expect(calls).toEqual(["get 1"]);

    calls.length = 0;
    await db.transaction(async (tx) => {
      const row = await tx.findOne("keys", { hash: "h" });
      expect(row).toMatchObject({ note: "a", _v: 0 });
      tx.update("keys", row!, { note: "b" });
    });
    expect(calls).toEqual(["get 1", "get 1"]);
    await expect(db.findOne("keys", { hash: "h" })).resolves.toMatchObject({
      note: "b",
    });
  });

  it("reruns a transaction whose index copy is older than its row", async () => {
    let interfere = false;
    const { adapter, db } = setup(async (keys) => {
      if (!interfere || keys[0]!.pk !== "keys") return;
      interfere = false;
      const [row] = await adapter.get(table, [["k"]]);
      await adapter.write([
        {
          type: "patch",
          table,
          key: ["k"],
          set: { note: "moved" },
          guard: { v: 0 },
          previous: row!,
        },
      ]);
    });
    await db.transaction(async (tx) => {
      tx.create("keys", { id: "k", hash: "h", note: "a" });
    });

    let runs = 0;
    const seen: unknown[] = [];
    await db.transaction(async (tx) => {
      runs += 1;
      interfere = runs === 1;
      const row = await tx.findOne("keys", { hash: "h" });
      seen.push(row?.note);
      tx.update("keys", row!, { note: `${row!.note}+` });
    });

    // The first run read the copy, then found its row moved on, and reran.
    expect(runs).toBe(2);
    expect(seen).toEqual(["moved"]);
    await expect(db.findOne("keys", { id: "k" })).resolves.toMatchObject({
      note: "moved+",
    });
  });
});
