import {
  type DatabaseAdapter,
  type DatabaseKey,
  DatabaseAdapterContractError,
  indexOrderTuple,
  findPhysicalIndex,
  type PhysicalTable,
  type QueryRequest,
  type StoredRow,
  type VerifiedDatabaseAdapter,
  verifyAdapter,
  type WriteOp,
  type WriteResult,
} from "@hot-updater/plugin-core/internal";
import { afterEach, describe, expect, it } from "vitest";

export interface DatabaseAdapterConformanceContext {
  readonly tables: readonly PhysicalTable[];
  /** Test-only: the adapter must fetch at most this many rows per native page. */
  readonly nativePageSize?: number;
}

export interface DatabaseAdapterConformanceOptions {
  readonly name: string;
  /** Returns an adapter over freshly created, empty tables. */
  readonly createAdapter: (
    context: DatabaseAdapterConformanceContext,
  ) => Promise<{
    readonly adapter: DatabaseAdapter;
    readonly cleanup?: () => Promise<void>;
  }>;
  /** The most ops one atomic write accepts; omit when the backend has no limit. */
  readonly maxOps?: number;
  /** Concurrent writers in the contention cases (default 32). */
  readonly writers?: number;
}

export const conformanceItems: PhysicalTable = {
  name: "conformance_items",
  columns: [
    { name: "id", type: "string", nullable: false, maxLength: 64 },
    { name: "grp", type: "string", nullable: false, maxLength: 64 },
    { name: "score", type: "integer", nullable: false },
    { name: "ratio", type: "number", nullable: true },
    { name: "flag", type: "boolean", nullable: false },
    { name: "label", type: "string", nullable: true, maxLength: 255 },
    {
      name: "tags",
      type: "string",
      nullable: true,
      maxLength: 64,
      multi: true,
    },
    { name: "payload", type: "json", nullable: true },
    { name: "note", type: "string", nullable: true },
    { name: "_v", type: "integer", nullable: false },
  ],
  key: ["id"],
  indexes: [
    { name: "all", eq: [], sort: ["id"] },
    { name: "byGroup", eq: ["grp"], sort: ["score"] },
    { name: "byGroupFlag", eq: ["grp", "flag"], sort: ["score"] },
    { name: "byLabel", eq: ["label"], sort: [], unique: true },
    { name: "byTag", eq: ["tags"], sort: ["score"] },
  ],
};

export const conformanceCounters: PhysicalTable = {
  name: "conformance_counters",
  columns: [
    { name: "scope", type: "string", nullable: false, maxLength: 64 },
    { name: "shard", type: "integer", nullable: false },
    { name: "hits", type: "integer", nullable: false },
    { name: "_v", type: "integer", nullable: false },
  ],
  key: ["scope", "shard"],
  indexes: [{ name: "byScope", eq: ["scope"], sort: ["shard"] }],
};

const tables = [conformanceItems, conformanceCounters] as const;

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

const counterKey = (scope: string, shard = 0): DatabaseKey => [scope, shard];
const counterInit = (scope: string, shard = 0): StoredRow => ({
  scope,
  shard,
  hits: 0,
  _v: 0,
});

const insert = (row: StoredRow): WriteOp => ({
  type: "insert",
  table: conformanceItems,
  row,
});

const shuffled = <T>(values: readonly T[]): T[] =>
  values
    .map((value) => ({ value, order: Math.random() }))
    .sort((left, right) => left.order - right.order)
    .map(({ value }) => value);

/**
 * The storage-adapter conformance contract (PRD S3 and S4 cases). Every
 * adapter runs it through `verifyAdapter`, which also checks each read and
 * write at the adapter boundary.
 */
export const setupDatabaseAdapterConformanceSuite = (
  options: DatabaseAdapterConformanceOptions,
): void => {
  const writers = options.writers ?? 32;
  let cleanup: (() => Promise<void>) | undefined;

  const setup = async (
    context: Partial<DatabaseAdapterConformanceContext> = {},
  ): Promise<VerifiedDatabaseAdapter> => {
    const created = await options.createAdapter({ tables, ...context });
    cleanup = created.cleanup;
    return verifyAdapter(created.adapter, { probeShortPages: true });
  };

  const ok = async (adapter: DatabaseAdapter, ops: readonly WriteOp[]) =>
    expect(await adapter.write(ops)).toEqual({ ok: true });

  const one = async (adapter: DatabaseAdapter, id: string) =>
    (await adapter.get(conformanceItems, [[id]]))[0] ?? null;

  const query = (
    adapter: DatabaseAdapter,
    request: Omit<QueryRequest, "order" | "limit"> &
      Partial<Pick<QueryRequest, "order" | "limit">>,
  ) =>
    adapter.query(conformanceItems, { order: "asc", limit: 500, ...request });

  const ids = (rows: readonly StoredRow[]) => rows.map((row) => row.id);

  const snapshot = async (adapter: DatabaseAdapter) => ({
    items: await query(adapter, { index: "all", eq: [] }),
    counters: await adapter.query(conformanceCounters, {
      index: "byScope",
      eq: ["c"],
      order: "asc",
      limit: 500,
    }),
  });

  describe(`${options.name} database adapter conformance`, () => {
    afterEach(async () => {
      await cleanup?.();
      cleanup = undefined;
    });

    it("round-trips every value type", async () => {
      const adapter = await setup();
      const rows = [
        item("round-trip", {
          grp: "Ωmega 😀",
          score: Number.MAX_SAFE_INTEGER,
          ratio: -1.25,
          flag: true,
          label: "",
          tags: ["b", "a"],
          payload: {
            nested: { list: [1, "two", null, true], ключ: "значение" },
            empty: {},
            none: [],
          },
          note: "x".repeat(10_000),
        }),
        item("round-trip-min", { score: Number.MIN_SAFE_INTEGER, ratio: 0.5 }),
      ];
      await ok(adapter, rows.map(insert));

      expect(
        await adapter.get(conformanceItems, [
          ["round-trip"],
          ["round-trip-min"],
        ]),
      ).toEqual(rows);
    });

    it("reads keys in request order with null for missing keys", async () => {
      const adapter = await setup();
      await ok(adapter, [insert(item("a")), insert(item("b"))]);

      expect(
        await adapter.get(conformanceItems, [["b"], ["missing"], ["a"]]),
      ).toEqual([item("b"), null, item("a")]);
      expect(await adapter.get(conformanceItems, [])).toEqual([]);
    });

    it("refuses an insert over an existing key", async () => {
      const adapter = await setup();
      await ok(adapter, [insert(item("a", { score: 1 }))]);

      expect(await adapter.write([insert(item("a", { score: 2 }))])).toEqual({
        ok: false,
        failedOp: 0,
      });
      expect(await one(adapter, "a")).toEqual(item("a", { score: 1 }));
    });

    it("patches named columns, bumps _v, and refuses a stale guard", async () => {
      const adapter = await setup();
      const row = item("a", { note: "keep" });
      await ok(adapter, [insert(row)]);
      const patch = (v: number, id = "a"): WriteOp => ({
        type: "patch",
        table: conformanceItems,
        key: [id],
        set: { score: 5 },
        guard: { v },
        previous: row,
      });

      await ok(adapter, [patch(0)]);
      expect(await one(adapter, "a")).toEqual({ ...row, score: 5, _v: 1 });
      expect(await adapter.write([patch(0)])).toEqual({
        ok: false,
        failedOp: 0,
      });
      expect(await adapter.write([patch(0, "missing")])).toEqual({
        ok: false,
        failedOp: 0,
      });
    });

    it("deletes only with a matching guard", async () => {
      const adapter = await setup();
      const row = item("a");
      await ok(adapter, [insert(row)]);
      const remove = (v: number): WriteOp => ({
        type: "delete",
        table: conformanceItems,
        key: ["a"],
        guard: { v },
        previous: row,
      });

      expect(await adapter.write([remove(1)])).toEqual({
        ok: false,
        failedOp: 0,
      });
      await ok(adapter, [remove(0)]);
      expect(await one(adapter, "a")).toBeNull();
      expect(await adapter.write([remove(0)])).toEqual({
        ok: false,
        failedOp: 0,
      });
    });

    it("increments counters, creating a missing row from init", async () => {
      const adapter = await setup();
      const increment = (
        values: Partial<Extract<WriteOp, { type: "increment" }>> = {},
      ): WriteOp => ({
        type: "increment",
        table: conformanceCounters,
        key: counterKey("c"),
        by: { hits: 2 },
        init: counterInit("c"),
        ...values,
      });

      await ok(adapter, [increment()]);
      await ok(adapter, [increment({ by: { hits: 3 } })]);
      expect(await adapter.get(conformanceCounters, [counterKey("c")])).toEqual(
        [{ scope: "c", shard: 0, hits: 5, _v: 2 }],
      );
      expect(await adapter.write([increment({ guard: { v: 1 } })])).toEqual({
        ok: false,
        failedOp: 0,
      });
      expect(
        await adapter.write([
          increment({ key: counterKey("c", 1), init: undefined }),
        ]),
      ).toEqual({ ok: false, failedOp: 0 });
    });

    it("checks a row version without writing it", async () => {
      const adapter = await setup();
      await ok(adapter, [insert(item("a"))]);
      const check = (v: number, id = "a"): WriteOp => ({
        type: "check",
        table: conformanceItems,
        key: [id],
        guard: { v },
      });

      await ok(adapter, [check(0)]);
      expect(await one(adapter, "a")).toEqual(item("a"));
      expect(await adapter.write([check(1)])).toEqual({
        ok: false,
        failedOp: 0,
      });
      expect(await adapter.write([check(0, "missing")])).toEqual({
        ok: false,
        failedOp: 0,
      });
    });

    it("applies nothing when an op at any position fails", async () => {
      const adapter = await setup();
      const rows = [item("a"), item("b"), item("d"), item("e")];
      await ok(adapter, [
        ...rows.map(insert),
        {
          type: "increment",
          table: conformanceCounters,
          key: counterKey("c"),
          by: { hits: 1 },
          init: counterInit("c"),
        },
      ]);
      const before = await snapshot(adapter);
      const batch = (stale: number): WriteOp[] => [
        insert(item(stale === 0 ? "e" : "x")),
        {
          type: "patch",
          table: conformanceItems,
          key: ["a"],
          set: { score: 9 },
          guard: { v: stale === 1 ? 7 : 0 },
          previous: rows[0]!,
        },
        {
          type: "delete",
          table: conformanceItems,
          key: ["b"],
          guard: { v: stale === 2 ? 7 : 0 },
          previous: rows[1]!,
        },
        {
          type: "increment",
          table: conformanceCounters,
          key: counterKey("c"),
          by: { hits: 1 },
          guard: { v: stale === 3 ? 7 : 1 },
        },
        {
          type: "check",
          table: conformanceItems,
          key: ["d"],
          guard: { v: stale === 4 ? 7 : 0 },
        },
      ];

      for (let stale = 0; stale < 5; stale += 1) {
        expect(await adapter.write(batch(stale))).toEqual({
          ok: false,
          failedOp: stale,
        });
        expect(await snapshot(adapter)).toEqual(before);
      }
      await ok(adapter, batch(-1));
      expect(ids(await query(adapter, { index: "all", eq: [] }))).toEqual([
        "a",
        "d",
        "e",
        "x",
      ]);
    });

    it("refuses a duplicate on a unique index with the failing op", async () => {
      const adapter = await setup();
      await ok(adapter, [insert(item("a", { label: "L" }))]);

      expect(
        await adapter.write([
          insert(item("b", { label: "M" })),
          insert(item("c", { label: "L" })),
        ]),
      ).toEqual({ ok: false, failedOp: 1 });
      expect(await one(adapter, "b")).toBeNull();
      await ok(adapter, [insert(item("b", { label: "M" }))]);
      expect(
        await adapter.write([
          {
            type: "patch",
            table: conformanceItems,
            key: ["b"],
            set: { label: "L" },
            guard: { v: 0 },
            previous: item("b", { label: "M" }),
          },
        ]),
      ).toEqual({ ok: false, failedOp: 0 });
      await ok(adapter, [insert(item("d")), insert(item("e"))]);
      await ok(adapter, [
        {
          type: "delete",
          table: conformanceItems,
          key: ["a"],
          guard: { v: 0 },
          previous: item("a", { label: "L" }),
        },
        insert(item("f", { label: "L" })),
      ]);
      expect(
        ids(await query(adapter, { index: "byLabel", eq: ["L"] })),
      ).toEqual(["f"]);
    });

    it("orders strings by UTF-8 bytes and numbers numerically", async () => {
      const adapter = await setup();
      const names = ["b", "B", "a", "é", "z", "😀", "ﬀ", "10", "9"];
      const scores = [10, -5, 2, 0, Number.MAX_SAFE_INTEGER];
      await ok(adapter, [
        ...names.map((id) => insert(item(id, { grp: "names" }))),
        ...scores.map((score) =>
          insert(item(`n${score}`, { grp: "n", score })),
        ),
      ]);

      expect(
        ids(await query(adapter, { index: "byGroup", eq: ["names"] })),
      ).toEqual(["10", "9", "B", "a", "b", "z", "é", "ﬀ", "😀"]);
      const byScore = await query(adapter, { index: "byGroup", eq: ["n"] });
      expect(byScore.map((row) => row.score)).toEqual([
        -5,
        0,
        2,
        10,
        Number.MAX_SAFE_INTEGER,
      ]);
      const reversed = await query(adapter, {
        index: "byGroup",
        eq: ["n"],
        order: "desc",
      });
      expect(ids(reversed)).toEqual(ids(byScore).toReversed());
    });

    it("pages through eq and bounds from a cursor without gaps or repeats", async () => {
      const adapter = await setup();
      const rows = Array.from({ length: 23 }, (_, index) =>
        item(`p${String(index).padStart(2, "0")}`, {
          grp: "p",
          score: Math.floor(index / 2),
          flag: index % 3 === 0,
        }),
      );
      await ok(adapter, [
        ...rows.map(insert),
        insert(item("q", { grp: "q", score: 3 })),
      ]);

      for (const order of ["asc", "desc"] as const) {
        const read: StoredRow[] = [];
        for (;;) {
          const last = read.at(-1);
          const bound =
            last === undefined
              ? {}
              : {
                  [order === "asc" ? "lower" : "upper"]: {
                    values: indexOrderTuple(
                      conformanceItems,
                      findPhysicalIndex(conformanceItems, "byGroup"),
                      last,
                    ),
                    inclusive: false,
                  },
                };
          const page = await query(adapter, {
            index: "byGroup",
            eq: ["p"],
            order,
            limit: 3,
            ...bound,
          });
          read.push(...page);
          if (page.length < 3) break;
        }
        const expected = ids(rows);
        expect(ids(read)).toEqual(
          order === "asc" ? expected : expected.toReversed(),
        );
      }
      expect(
        ids(
          await query(adapter, {
            index: "byGroup",
            eq: ["p"],
            lower: { values: [3], inclusive: true },
            upper: { values: [5], inclusive: false },
          }),
        ),
      ).toEqual(["p06", "p07", "p08", "p09"]);
      expect(
        ids(
          await query(adapter, {
            index: "byGroupFlag",
            eq: ["p", true],
            lower: { values: [6, "p12"], inclusive: false },
          }),
        ),
      ).toEqual(["p15", "p18", "p21"]);
    });

    it("indexes every value of a multi-valued field", async () => {
      const adapter = await setup();
      const a = item("a", { tags: ["x", "y"], score: 2 });
      await ok(adapter, [
        insert(a),
        insert(item("b", { tags: ["y"], score: 1 })),
        insert(item("c", { tags: [] })),
        insert(item("d")),
      ]);
      const tagged = async (tag: string) =>
        ids(await query(adapter, { index: "byTag", eq: [tag] }));

      expect(await tagged("x")).toEqual(["a"]);
      expect(await tagged("y")).toEqual(["b", "a"]);
      await ok(adapter, [
        {
          type: "patch",
          table: conformanceItems,
          key: ["a"],
          set: { tags: ["z"] },
          guard: { v: 0 },
          previous: a,
        },
      ]);
      expect(await tagged("x")).toEqual([]);
      expect(await tagged("z")).toEqual(["a"]);
      await ok(adapter, [
        {
          type: "delete",
          table: conformanceItems,
          key: ["a"],
          guard: { v: 1 },
          previous: { ...a, tags: ["z"], _v: 1 },
        },
      ]);
      expect(await tagged("z")).toEqual([]);
    });

    it("fills every page when native pages are capped", async () => {
      const adapter = await setup({ nativePageSize: 2 });
      await ok(
        adapter,
        Array.from({ length: 9 }, (_, index) => insert(item(`r${index}`))),
      );

      const first = await query(adapter, { index: "all", eq: [], limit: 5 });
      expect(ids(first)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
      const second = await query(adapter, {
        index: "all",
        eq: [],
        limit: 5,
        lower: { values: ["r4"], inclusive: false },
      });
      expect(ids(second)).toEqual(["r5", "r6", "r7", "r8"]);
    });

    it(`lets exactly one of ${writers} concurrent writers win a contested key`, async () => {
      const adapter = await setup();
      const row = item("a");
      await ok(adapter, [insert(row)]);

      const results = await Promise.all(
        shuffled(Array.from({ length: writers }, (_, index) => index)).map(
          (index) =>
            adapter.write([
              {
                type: "patch",
                table: conformanceItems,
                key: ["a"],
                set: { score: index + 1 },
                guard: { v: 0 },
                previous: row,
              },
            ]),
        ),
      );

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(
        results.every(
          (result) => result.ok || "retry" in result || result.failedOp === 0,
        ),
      ).toBe(true);
      expect(await one(adapter, "a")).toMatchObject({ _v: 1 });
    });

    it(`loses no increments under ${writers} concurrent writers`, async () => {
      const adapter = await setup();
      const incrementUntilCommitted = async () => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const result: WriteResult = await adapter.write([
            {
              type: "increment",
              table: conformanceCounters,
              key: counterKey("c"),
              by: { hits: 1 },
              init: counterInit("c"),
            },
          ]);
          if (result.ok) return;
          if (!("retry" in result)) throw new Error("increment failed");
        }
        throw new Error("increment kept retrying");
      };

      await Promise.all(
        Array.from({ length: writers }, () => incrementUntilCommitted()),
      );

      expect(await adapter.get(conformanceCounters, [counterKey("c")])).toEqual(
        [{ scope: "c", shard: 0, hits: writers, _v: writers }],
      );
    });

    it("rejects write skew between two checked writers", async () => {
      const adapter = await setup();
      const a = item("a");
      const b = item("b");
      await ok(adapter, [insert(a), insert(b)]);
      const skew = (read: StoredRow, written: StoredRow): WriteOp[] => [
        {
          type: "check",
          table: conformanceItems,
          key: [read.id as string],
          guard: { v: 0 },
        },
        {
          type: "patch",
          table: conformanceItems,
          key: [written.id as string],
          set: { score: 1 },
          guard: { v: 0 },
          previous: written,
        },
      ];

      const results = await Promise.all([
        adapter.write(skew(a, b)),
        adapter.write(skew(b, a)),
      ]);

      expect(results.filter((result) => result.ok).length).toBeLessThanOrEqual(
        1,
      );
    });

    it.skipIf(options.maxOps === undefined)(
      "rejects an over-limit write before sending it",
      async () => {
        const adapter = await setup();
        const ops = Array.from(
          { length: (options.maxOps ?? 0) + 1 },
          (_, index) => insert(item(`over${index}`)),
        );

        expect(adapter.fits(ops)).toBe(false);
        await expect(adapter.write(ops)).rejects.toThrow(
          DatabaseAdapterContractError,
        );
        expect(await query(adapter, { index: "all", eq: [] })).toEqual([]);
      },
    );
  });
};
