import {
  coreTarget,
  type DatabaseAdapter,
  type PhysicalTable,
  type QueryBound,
  type StoredRow,
} from "@hot-updater/plugin-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Core's partition table, as every route creates it. */
export const releaseCatalogPartitionsTable: PhysicalTable = (() => {
  const table = coreTarget.schema.tables.find(
    ({ name }) => name === "release_catalog_partitions",
  );
  if (!table) throw new Error("core has no release_catalog_partitions table");
  return table;
})();

export interface KeyOrderTestSuiteOptions {
  readonly name: string;
  /**
   * Returns an adapter over `release_catalog_partitions` created the way the
   * route under test creates it (its generated DDL, ORM schema, managed
   * migration or store), under the route's table prefix, and empty. `table`
   * is the table as core resolves it.
   */
  readonly createAdapter: (context: {
    readonly table: PhysicalTable;
  }) => Promise<{
    readonly adapter: DatabaseAdapter;
    readonly cleanup?: () => Promise<void>;
  }>;
  /**
   * The longest scope key whose rows the store's key holds, in bytes
   * (default 2,048, the column's length). DynamoDB's 1,024-byte sort key
   * holds the scope key, the epoch and the lower key together.
   */
  readonly maxScopeKeyBytes?: number;
}

type Key = readonly [scope: string, epoch: string, lower: string];

const utf8 = new TextEncoder();

/** Byte order of a key tuple: each column's UTF-8 bytes, then the next column. */
const compareKeys = (left: readonly string[], right: readonly string[]) => {
  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    if (left[at] === undefined) return -1;
    if (right[at] === undefined) return 1;
    const [a, b] = [utf8.encode(left[at]!), utf8.encode(right[at]!)];
    for (let byte = 0; byte < Math.min(a.length, b.length); byte += 1) {
      if (a[byte] !== b[byte]) return a[byte]! - b[byte]!;
    }
    if (a.length !== b.length) return a.length - b.length;
  }
  return 0;
};

const UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const LONG = 256;

/**
 * Keys within one scope, as partition rows, staging rows and epoch markers
 * key them: `!` and `#` epochs below every epoch ID, lower keys that differ
 * at each printable ASCII class, prefixes of one another, and keys of the
 * column's full length. No two differ only in letter case, so a
 * case-insensitive collation fails the order cases, not the inserts. Every
 * key is printable ASCII from `!` (0x21) to `~` (0x7E): MySQL's `ascii_bin`
 * pads with spaces, so a key with a byte at or below 0x20 after a common
 * prefix sorts out of byte order there (`"a\x1f"` before `"a"`).
 */
const scopeKeys: readonly (readonly [string, string])[] = [
  ["!", "!"],
  ["#", "0a"],
  ["#", UUID],
  ["0a", ""],
  ["0a", "!"],
  ["0a", "-"],
  ["0a", "."],
  ["0a", "1.10"],
  ["0a", "1.9"],
  ["0a", "Z"],
  ["0a", "_"],
  ["0a", "a"],
  ["0a", "a!"],
  ["0a", "a~"],
  ["0a", "b"],
  ["0a", "|"],
  ["0a", "z".repeat(LONG)],
  ["0a", "~".repeat(LONG - 1)],
  ["0a", "~".repeat(LONG)],
  ["0b", "M"],
  ["0b", "m!"],
  [UUID, "1.0.0"],
  [UUID, "~"],
];

/** Lower keys a predecessor read looks up between and beyond the stored ones. */
const probes = [
  "",
  "!",
  '"',
  "0",
  "1.1",
  "1.10!",
  "1.9~",
  "A",
  "Y",
  "[",
  "`",
  "a",
  "a!!",
  "aa",
  "c",
  "z".repeat(LONG - 1),
  "z".repeat(LONG),
  "{",
  "~".repeat(LONG),
];

/**
 * The physical key order `release_catalog_partitions` relies on, through the
 * adapter a route serves with, on the table as the route creates it: every
 * scan, page and predecessor read of `byScope` follows the bytes of
 * `(scope_key, epoch, lower_key)`, keys that differ only in letter case are
 * distinct rows, and a full-length key reads back exactly.
 */
export const setupKeyOrderTestSuite = (
  options: KeyOrderTestSuiteOptions,
): void => {
  const table = releaseCatalogPartitionsTable;
  const longScope = `l${"~".repeat((options.maxScopeKeyBytes ?? 2048) - 1)}`;
  // Scope keys that share a prefix, so an `eq` read must not take a neighbour's rows.
  const scopes = ["s", "s!", "s0", longScope];
  const rows: Key[] = [
    ...scopeKeys.map(([epoch, lower]) => ["s", epoch, lower] as const),
    ...["s!", "s0", longScope].flatMap((scope) => [
      [scope, "0a", "a"] as const,
      [scope, "0a", "b"] as const,
    ]),
  ];
  const sorted = (scope: string) =>
    rows
      .filter(([rowScope]) => rowScope === scope)
      .toSorted(compareKeys)
      .map(([, epoch, lower]) => [epoch, lower] as const);

  const toRow = ([scope_key, epoch, lower_key]: Key, generation = 1) => ({
    scope_key,
    epoch,
    lower_key,
    generation,
    payload: JSON.stringify({ epoch, lower_key }),
    partition_hash: `sha256:${"0".repeat(64)}`,
    byte_size: 0,
    _v: 0,
  });
  const keysOf = (found: readonly StoredRow[]) =>
    found.map((row) => [row.epoch, row.lower_key] as const);

  let adapter: DatabaseAdapter;
  let cleanup: (() => Promise<void>) | undefined;

  const read = (
    scope: string,
    request: {
      readonly lower?: QueryBound;
      readonly upper?: QueryBound;
      readonly order: "asc" | "desc";
      readonly limit: number;
    },
  ) => adapter.query(table, { index: "byScope", eq: [scope], ...request });

  describe(`release_catalog_partitions key order (${options.name})`, () => {
    beforeAll(async () => {
      ({ adapter, cleanup } = await options.createAdapter({ table }));
      for (let at = 0; at < rows.length; at += 10) {
        const batch = rows.slice(at, at + 10);
        expect(
          await adapter.write(
            batch.map((key) => ({ type: "insert", table, row: toRow(key) })),
          ),
        ).toEqual({ ok: true });
      }
    }, 120_000);

    afterAll(async () => {
      await cleanup?.();
    }, 60_000);

    it("reads every row back by its exact key, the longest included", async () => {
      const found = await adapter.get(table, rows);
      expect(
        found.map((row) => [row?.scope_key, row?.epoch, row?.lower_key]),
      ).toEqual(rows);
      expect(
        await adapter.get(table, [
          ["s", "0a", "~".repeat(LONG - 1)],
          ["s", "0a", "A"],
          ["s", "0A", "a"],
          ["s", "0a", "a!!"],
          ["s", "0a", "~".repeat(LONG - 2)],
        ]),
      ).toEqual([
        expect.objectContaining({ lower_key: "~".repeat(LONG - 1) }),
        null,
        null,
        null,
        null,
      ]);
    });

    it.each(["asc", "desc"] as const)(
      "scans each scope in byte order, %s, and only its own rows",
      async (order) => {
        for (const scope of scopes) {
          const expected = sorted(scope);
          expect(keysOf(await read(scope, { order, limit: 500 }))).toEqual(
            order === "asc" ? expected : expected.toReversed(),
          );
        }
      },
    );

    it.each(["asc", "desc"] as const)(
      "pages a scope two rows at a time past each page's last key, %s",
      async (order) => {
        const expected = sorted("s");
        const walked: (readonly [unknown, unknown])[] = [];
        let bound: QueryBound | undefined;
        for (let pages = 0; pages <= expected.length; pages += 1) {
          const page = await read("s", {
            order,
            limit: 2,
            ...(bound &&
              (order === "asc" ? { lower: bound } : { upper: bound })),
          });
          if (page.length === 0) break;
          expect(page.length).toBeLessThanOrEqual(2);
          walked.push(...keysOf(page));
          const last = page.at(-1)!;
          bound = {
            values: [String(last.epoch), String(last.lower_key)],
            inclusive: false,
          };
        }
        expect(walked).toEqual(
          order === "asc" ? expected : expected.toReversed(),
        );
        // An inclusive bound at a page's last key starts the next page with it.
        const [first, second] = expected;
        expect(
          keysOf(
            await read("s", {
              order: "asc",
              limit: 2,
              lower: { values: [...second!], inclusive: true },
            }),
          ),
        ).toEqual([second, expected[2]]);
        expect(
          keysOf(
            await read("s", {
              order: "desc",
              limit: 1,
              upper: { values: [...second!], inclusive: false },
            }),
          ),
        ).toEqual([first]);
      },
    );

    it("finds the predecessor of every key, inclusive and exclusive, within and across epochs", async () => {
      const expected = sorted("s");
      const epochs = [...new Set(expected.map(([epoch]) => epoch))];
      const lowers = [
        ...new Set([...expected.map(([, lower]) => lower), ...probes]),
      ];
      for (const epoch of epochs) {
        for (const lower of lowers) {
          for (const inclusive of [true, false]) {
            const at = [epoch, lower];
            const below = expected.filter((key) => {
              const order = compareKeys(key, at);
              return inclusive ? order <= 0 : order < 0;
            });
            const across = below.at(-1) ?? null;
            const within =
              below.filter(([rowEpoch]) => rowEpoch === epoch).at(-1) ?? null;
            const upper = { values: at, inclusive };
            const label = `${inclusive ? "<=" : "<"} (${epoch}, ${lower.slice(0, 12)}…${lower.length})`;
            expect(
              keysOf(await read("s", { order: "desc", limit: 1, upper }))[0] ??
                null,
              label,
            ).toEqual(across);
            // The update check's read: within the live epoch, from its first key.
            expect(
              keysOf(
                await read("s", {
                  order: "desc",
                  limit: 1,
                  lower: { values: [epoch, ""], inclusive: true },
                  upper,
                }),
              )[0] ?? null,
              `${label} within ${epoch}`,
            ).toEqual(within);
          }
        }
      }
    }, 300_000);

    it("reads key-prefix ranges: the staging row and markers, and one epoch", async () => {
      const expected = sorted("s");
      // `[(S, "!"), (S, "$"))`: the staging row and every marker, no partition.
      expect(
        keysOf(
          await read("s", {
            order: "asc",
            limit: 500,
            lower: { values: ["!"], inclusive: true },
            upper: { values: ["$"], inclusive: false },
          }),
        ),
      ).toEqual(expected.filter(([epoch]) => epoch === "!" || epoch === "#"));
      for (const epoch of ["0a", "0b", UUID]) {
        for (const order of ["asc", "desc"] as const) {
          const own = expected.filter(([rowEpoch]) => rowEpoch === epoch);
          expect(
            keysOf(
              await read("s", {
                order,
                limit: 500,
                lower: { values: [epoch], inclusive: true },
                upper: { values: [epoch], inclusive: true },
              }),
            ),
          ).toEqual(order === "asc" ? own : own.toReversed());
          // Exclusive prefix bounds leave the epoch out.
          const after = await read("s", {
            order: "asc",
            limit: 1,
            lower: { values: [epoch], inclusive: false },
          });
          expect(keysOf(after)).toEqual(
            expected
              .filter((key) => compareKeys([key[0]], [epoch]) > 0)
              .slice(0, 1),
          );
        }
      }
    });

    it("keeps keys that differ only in letter case, or by a suffix, as distinct rows in byte order", async () => {
      const cases: Key[] = [
        ["c", "0a", "A"],
        ["c", "0a", "a"],
        ["c", "0a", "A!"],
        ["c", "0a", "a!"],
        ["c", "0A", "a"],
        ["c", "0a", "Ab"],
        ["c", "0a", "aB"],
        ["C", "0a", "a"],
      ];
      for (const key of cases) {
        expect(
          await adapter.write([{ type: "insert", table, row: toRow(key, 2) }]),
          key.join(" "),
        ).toEqual({ ok: true });
      }
      const found = await adapter.get(table, cases);
      expect(
        found.map((row) => [row?.scope_key, row?.epoch, row?.lower_key]),
      ).toEqual(cases);
      const own = cases
        .filter(([scope]) => scope === "c")
        .toSorted(compareKeys);
      expect(
        (await read("c", { order: "asc", limit: 500 })).map((row) => [
          row.scope_key,
          row.epoch,
          row.lower_key,
        ]),
      ).toEqual(own);
      expect(
        keysOf(
          await read("c", {
            order: "desc",
            limit: 1,
            upper: { values: ["0a", "a"], inclusive: false },
          }),
        ),
      ).toEqual([["0a", "Ab"]]);
      expect(
        keysOf(
          await read("c", {
            order: "desc",
            limit: 1,
            upper: { values: ["0a", "a"], inclusive: true },
          }),
        ),
      ).toEqual([["0a", "a"]]);
    });
  });
};
