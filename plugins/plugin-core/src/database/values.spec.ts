import { describe, expect, it } from "vitest";

import type { PhysicalTable } from "./adapter";
import {
  compareTuples,
  compareUtf8,
  DatabaseValueError,
  indexEntries,
  normalizeStoredRow,
} from "./values";

const table: PhysicalTable = {
  name: "values",
  columns: [
    { name: "id", type: "string", nullable: false },
    { name: "size", type: "integer", nullable: false },
    { name: "ratio", type: "number", nullable: true },
    { name: "enabled", type: "boolean", nullable: false },
    { name: "tags", type: "string", nullable: true, multi: true },
    { name: "meta", type: "json", nullable: true },
  ],
  key: ["id"],
  indexes: [{ name: "byTag", eq: ["tags", "enabled"], sort: ["size"] }],
};

describe("database value helpers", () => {
  it("orders strings by UTF-8 bytes rather than UTF-16 code units", () => {
    expect(compareUtf8("ﬀ", "😀")).toBeLessThan(0);
    expect("ﬀ" < "😀").toBe(false);
    expect(compareUtf8("B", "a")).toBeLessThan(0);
    expect(compareUtf8("ab", "a")).toBeGreaterThan(0);
    expect(compareUtf8("😀", "😀")).toBe(0);
  });

  it("orders tuples element by element with shorter prefixes first", () => {
    expect(compareTuples([1, "b"], [1, "a"])).toBeGreaterThan(0);
    expect(compareTuples([1], [1, "a"])).toBeLessThan(0);
    expect(compareTuples([false], [true])).toBeLessThan(0);
    expect(() => compareTuples([1], ["1"])).toThrow(DatabaseValueError);
  });

  it("indexes each multi value and skips rows with a null index field", () => {
    const row = { id: "a", size: 1, enabled: true, tags: ["x", "y", "x"] };
    expect(indexEntries(table, table.indexes[0]!, row)).toEqual([
      ["x", true],
      ["y", true],
    ]);
    expect(
      indexEntries(table, table.indexes[0]!, { ...row, tags: [] }),
    ).toEqual([]);
    expect(
      indexEntries(table, table.indexes[0]!, { ...row, tags: null }),
    ).toEqual([]);
  });

  it("normalizes int8 text, BigInt, Decimal, 0/1, and JSON text", () => {
    const decimal = { toString: () => "2.5" };
    expect(
      normalizeStoredRow(
        table,
        {
          id: "a",
          size: "9007199254740991",
          ratio: decimal,
          enabled: 1,
          tags: '["x"]',
          meta: '{"a":[1]}',
          extra: "dropped",
        },
        { jsonText: true },
      ),
    ).toEqual({
      id: "a",
      size: Number.MAX_SAFE_INTEGER,
      ratio: 2.5,
      enabled: true,
      tags: ["x"],
      meta: { a: [1] },
    });
    expect(
      normalizeStoredRow(
        table,
        { id: "b", size: 3n, enabled: false, meta: "text" },
        { jsonText: false },
      ),
    ).toMatchObject({ size: 3, ratio: null, tags: null, meta: "text" });
    // Prisma reads a SQLite BIGINT flag as a BigInt.
    expect(
      normalizeStoredRow(
        table,
        { id: "c", size: 1, enabled: 1n },
        { jsonText: true },
      ),
    ).toMatchObject({ enabled: true });
  });

  it("rejects integers outside the safe range and non-boolean flags", () => {
    expect(() =>
      normalizeStoredRow(
        table,
        { id: "a", size: "9007199254740992", enabled: 0 },
        { jsonText: false },
      ),
    ).toThrow(DatabaseValueError);
    expect(() =>
      normalizeStoredRow(
        table,
        { id: "a", size: 1, enabled: "yes" },
        { jsonText: false },
      ),
    ).toThrow(DatabaseValueError);
  });
});
