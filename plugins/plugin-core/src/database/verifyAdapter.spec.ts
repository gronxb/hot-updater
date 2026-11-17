import { describe, expect, it } from "vitest";

import type {
  DatabaseAdapter,
  PhysicalTable,
  QueryRequest,
  StoredRow,
  WriteResult,
} from "./adapter";
import { createMemoryAdapter } from "./memoryAdapter";
import { DatabaseAdapterContractError, verifyAdapter } from "./verifyAdapter";

const table: PhysicalTable = {
  name: "rows",
  columns: [
    { name: "id", type: "string", nullable: false },
    { name: "grp", type: "string", nullable: false },
    { name: "n", type: "integer", nullable: false },
    { name: "_v", type: "integer", nullable: false },
  ],
  key: ["id"],
  indexes: [{ name: "byGroup", eq: ["grp"], sort: ["n"] }],
};

const row = (id: string, n: number, grp = "g"): StoredRow => ({
  id,
  grp,
  n,
  _v: 0,
});

const request: QueryRequest = {
  index: "byGroup",
  eq: ["g"],
  order: "asc",
  limit: 3,
};

const fake = (overrides: Partial<DatabaseAdapter>): DatabaseAdapter => ({
  id: "fake",
  fits: () => true,
  get: async (_table, keys) => keys.map(() => null),
  query: async () => [],
  write: async () => ({ ok: true }),
  ...overrides,
});

describe("verifyAdapter", () => {
  it("rejects rows out of order, outside eq, or over the limit", async () => {
    const answers: StoredRow[][] = [
      [row("b", 2), row("a", 1)],
      [row("a", 1, "other")],
      [row("a", 1), row("b", 2), row("c", 3), row("d", 4)],
    ];
    for (const rows of answers) {
      const adapter = verifyAdapter(fake({ query: async () => rows }));
      await expect(adapter.query(table, request)).rejects.toThrow(
        DatabaseAdapterContractError,
      );
    }
  });

  it("accepts descending order and rejects a short page before the range ends", async () => {
    const all = [row("a", 1), row("b", 2), row("c", 3)];
    const descending = verifyAdapter(
      fake({ query: async () => all.toReversed() }),
    );
    await expect(
      descending.query(table, { ...request, order: "desc" }),
    ).resolves.toHaveLength(3);

    const short = verifyAdapter(
      fake({
        query: async (_table, current) =>
          current.limit === 1 ? [all[2]!] : all.slice(0, 2),
      }),
      { probeShortPages: true },
    );
    await expect(short.query(table, request)).rejects.toThrow("short page");
  });

  it("rejects limits outside 1-500 and unbound eq columns", async () => {
    const adapter = verifyAdapter(fake({}));
    for (const invalid of [
      { ...request, limit: 0 },
      { ...request, limit: 501 },
      { ...request, eq: [] },
    ]) {
      await expect(adapter.query(table, invalid)).rejects.toThrow(
        DatabaseAdapterContractError,
      );
    }
  });

  it("rejects two ops on one key, key patches, and a failedOp out of range", async () => {
    const adapter = verifyAdapter(
      fake({
        write: async (): Promise<WriteResult> => ({ ok: false, failedOp: 5 }),
      }),
    );
    await expect(
      adapter.write([
        { type: "insert", table, row: row("a", 1) },
        { type: "check", table, key: ["a"], guard: { v: 0 } },
      ]),
    ).rejects.toThrow("twice");
    await expect(
      adapter.write([
        {
          type: "patch",
          table,
          key: ["a"],
          set: { id: "b" },
          guard: { v: 0 },
          previous: row("a", 1),
        },
      ]),
    ).rejects.toThrow("key columns");
    await expect(
      adapter.write([{ type: "insert", table, row: row("a", 1) }]),
    ).rejects.toThrow("failedOp 5");
  });

  it("counts point reads and returned rows per table", async () => {
    const adapter = verifyAdapter(createMemoryAdapter());
    await adapter.write([
      { type: "insert", table, row: row("a", 1) },
      { type: "insert", table, row: row("b", 2) },
    ]);
    await adapter.get(table, [["a"], ["missing"]]);
    await adapter.query(table, request);
    await adapter.query(table, { ...request, eq: ["empty"] });

    expect(adapter.reads.byTable("rows")).toEqual({
      gets: 1,
      keys: 2,
      queries: 2,
      rows: 2,
    });
    adapter.reads.reset();
    expect(adapter.reads.total()).toEqual({
      gets: 0,
      keys: 0,
      queries: 0,
      rows: 0,
    });
  });
});
