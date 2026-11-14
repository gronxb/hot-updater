import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import {
  conformanceCounters,
  conformanceExpiring,
  conformanceItems,
  setupDatabaseAdapterConformanceSuite,
} from "@hot-updater/test-utils";
import {
  pgliteBatchExecutor,
  pgliteExecutor,
  sqliteBatchExecutor,
  sqliteExecutor,
} from "@hot-updater/test-utils/node";
import { afterAll, describe, expect, it } from "vitest";

import type { PhysicalTable, WriteOp } from "../../../database/adapter";
import { coreSchema } from "../../db/coreDatabase";
import { resolveSchema } from "../resolveSchema";
import { defineTable } from "../schema";
import {
  createSqlAdapter,
  type SqlConnection,
  type SqlExecutor,
  type SqlStatement,
  WRITE_GUARD_TABLE,
  classifySqlError,
} from "./sqlAdapter";
import { createTableStatements, pruneStatements } from "./sqlSchema";

const pglite = new PGlite();
afterAll(() => pglite.close());
let tests = 0;

setupDatabaseAdapterConformanceSuite({
  name: "sql (PGlite)",
  maxOps: 50,
  createAdapter: async ({ tables }) => {
    tests += 1;
    const adapter = createSqlAdapter({
      executor: pgliteExecutor(pglite),
      tablePrefix: `t${tests}_`,
      maxOps: 50,
    });
    await adapter.migrations?.apply(tables);
    return { adapter };
  },
});

setupDatabaseAdapterConformanceSuite({
  name: "sql (SQLite)",
  maxOps: 50,
  createAdapter: async ({ tables }) => {
    const db = new DatabaseSync(":memory:");
    const adapter = createSqlAdapter({
      executor: sqliteExecutor(db),
      maxOps: 50,
    });
    await adapter.migrations?.apply(tables);
    return { adapter, cleanup: async () => db.close() };
  },
});

/** Batch writes: every guard first, then the changes, in one atomic batch (D1). */
setupDatabaseAdapterConformanceSuite({
  name: "sql batch (SQLite)",
  maxOps: 50,
  createAdapter: async ({ tables }) => {
    const db = new DatabaseSync(":memory:");
    const adapter = createSqlAdapter({
      executor: sqliteBatchExecutor(db),
      maxOps: 50,
    });
    await adapter.migrations?.apply([...tables, WRITE_GUARD_TABLE]);
    return { adapter, cleanup: async () => db.close() };
  },
});

setupDatabaseAdapterConformanceSuite({
  name: "sql batch (PGlite)",
  maxOps: 50,
  createAdapter: async ({ tables }) => {
    tests += 1;
    const adapter = createSqlAdapter({
      executor: pgliteBatchExecutor(pglite),
      tablePrefix: `b${tests}_`,
      maxOps: 50,
    });
    await adapter.migrations?.apply([...tables, WRITE_GUARD_TABLE]);
    return { adapter };
  },
});

/** Records statements and answers every read with no rows. */
const recorder = (dialect: SqlExecutor["dialect"], maxParams?: number) => {
  const statements: SqlStatement[] = [];
  const execute = async (statement: SqlStatement) => {
    statements.push(statement);
    const version = statement.sql.startsWith('SELECT "_v"');
    return { rows: version ? [{ _v: 1 }] : [], changes: 1 };
  };
  const executor: SqlExecutor = {
    dialect,
    execute,
    transaction: (fn) => fn({ execute }),
  };
  return {
    statements,
    adapter: createSqlAdapter({
      executor,
      ...(maxParams === undefined ? {} : { maxParams }),
    }),
  };
};

describe("sql core", () => {
  it("splits a batch read so no statement binds more than maxParams", async () => {
    const { statements, adapter } = recorder("sqlite", 5);
    const keys = ["a", "b", "c", "d", "e", "f"].map((scope) => [scope, 0]);
    await expect(adapter.get(conformanceCounters, keys)).resolves.toEqual(
      keys.map(() => null),
    );
    expect(statements.map(({ params }) => params.length)).toEqual([4, 4, 4]);
  });

  it("stores ASCII strings single-byte on MySQL and refuses a key over its byte limit", () => {
    const scopeKey = {
      name: "scope_key",
      type: "string",
      nullable: false,
      maxLength: 2048,
    } as const;
    const catalogs = (ascii: boolean): PhysicalTable => ({
      name: "catalogs",
      columns: [
        ascii ? { ...scopeKey, ascii: true } : scopeKey,
        { name: "_v", type: "integer", nullable: false },
      ],
      key: ["scope_key"],
      indexes: [],
    });
    expect(createTableStatements("mysql", [catalogs(true)])[0]).toContain(
      "`scope_key` varchar(2048) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
    );
    expect(createTableStatements("postgresql", [catalogs(true)])[0]).toContain(
      '"scope_key" varchar(2048) COLLATE "C" NOT NULL',
    );
    expect(() => createTableStatements("mysql", [catalogs(false)])).toThrow(
      "catalogs key needs 8192 bytes on MySQL, over its 3072",
    );
    // A derived column keeps its bound: a slot holding a scope key fits.
    const slots = resolveSchema([
      {
        id: "core",
        schema: {
          slots: defineTable(
            {
              id: { type: "string", maxLength: 36 },
              scope_key: { type: "string", maxLength: 2048, ascii: true },
              held: { type: "boolean" },
            },
            {
              key: ["id"],
              derived: {
                held_scope_key: {
                  type: "string",
                  maxLength: 2048,
                  ascii: true,
                  compute: (row) => (row.held ? row.scope_key : null),
                },
              },
              indexes: {
                byHeldScope: { eq: ["held_scope_key"], sort: [], unique: true },
              },
            },
          ),
        },
      },
    ]).tables;
    expect(createTableStatements("mysql", slots)[0]).toContain(
      "`held_scope_key` varchar(2048) CHARACTER SET ascii COLLATE ascii_bin,",
    );
    expect(createTableStatements("postgresql", slots)[0]).toContain(
      '"held_scope_key" varchar(2048) COLLATE "C",',
    );
    // every core table fits; the plugins' tables are checked beside them
    expect(() =>
      createTableStatements("mysql", coreSchema.tables),
    ).not.toThrow();
  });

  it("creates tables with binary collation, an index table per multi-valued index, and no index that repeats the key", () => {
    const counters: PhysicalTable = conformanceCounters;
    expect(createTableStatements("postgresql", [counters], "hu_")).toEqual([
      'CREATE TABLE IF NOT EXISTS "hu_conformance_counters" ("scope" varchar(64) COLLATE "C" NOT NULL, "shard" bigint NOT NULL, "hits" bigint NOT NULL, "_v" bigint NOT NULL, PRIMARY KEY ("scope", "shard"))',
    ]);
    expect(createTableStatements("mysql", [counters])).toEqual([
      "CREATE TABLE IF NOT EXISTS `conformance_counters` (`scope` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL, `shard` bigint NOT NULL, `hits` bigint NOT NULL, `_v` bigint NOT NULL, PRIMARY KEY (`scope`, `shard`))",
    ]);
    const items = createTableStatements("sqlite", [conformanceItems]);
    expect(items).toContain(
      'CREATE TABLE IF NOT EXISTS "conformance_items__byTag" ("tags" TEXT NOT NULL, "score" INTEGER NOT NULL, "id" TEXT NOT NULL, PRIMARY KEY ("tags", "score", "id"))',
    );
    expect(items).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "conformance_items_byLabel" ON "conformance_items" ("label")',
    );
    expect(createTableStatements("mysql", [conformanceItems])[0]).toContain(
      "`note` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
    );
    expect(
      createTableStatements("postgresql", [
        {
          ...counters,
          indexes: [{ name: "byShard", eq: ["shard"], sort: ["scope"] }],
        },
      ])[1],
    ).toBe(
      'CREATE INDEX IF NOT EXISTS "conformance_counters_byShard" ON "conformance_counters" ("shard", "scope")',
    );
  });

  it("compares order tuples with row values, or with expanded ORs on MySQL", async () => {
    const request = {
      index: "byGroup",
      eq: ["g"],
      order: "asc" as const,
      limit: 3,
      lower: { values: [2, "p"], inclusive: false },
      upper: { values: [9], inclusive: true },
    };
    const postgres = recorder("postgresql");
    await postgres.adapter.query(conformanceItems, request);
    expect(postgres.statements[0]).toEqual({
      sql: 'SELECT i.* FROM "conformance_items" i WHERE i."grp" = $1 AND (i."score", i."id") > ($2, $3) AND i."score" <= $4 ORDER BY i."score" ASC, i."id" ASC LIMIT 3',
      params: ["g", 2, "p", 9],
    });
    const mysql = recorder("mysql");
    await mysql.adapter.query(conformanceItems, request);
    expect(mysql.statements[0]!.sql).toBe(
      "SELECT i.* FROM `conformance_items` i WHERE i.`grp` = ? AND ((i.`score` > ?) OR (i.`score` = ? AND i.`id` > ?)) AND i.`score` <= ? ORDER BY i.`score` ASC, i.`id` ASC LIMIT 3",
    );
    expect(mysql.statements[0]!.params).toEqual(["g", 2, 2, "p", 9]);
  });

  it("guards patches on _v, locks checked rows, and upserts counters", async () => {
    const { statements, adapter } = recorder("postgresql");
    await adapter.write([
      {
        type: "patch",
        table: conformanceCounters,
        key: ["c", 0],
        set: { hits: 4 },
        guard: { v: 3 },
        previous: { scope: "c", shard: 0, hits: 1, _v: 3 },
      },
      {
        type: "check",
        table: conformanceCounters,
        key: ["d", 0],
        guard: { v: 1 },
      },
      {
        type: "increment",
        table: conformanceCounters,
        key: ["e", 0],
        by: { hits: 2 },
        init: { scope: "e", shard: 0, hits: 0, _v: 0 },
      },
    ]);
    expect(statements.map(({ sql }) => sql)).toEqual([
      'UPDATE "conformance_counters" SET "hits" = $1, "_v" = "_v" + 1 WHERE "scope" = $2 AND "shard" = $3 AND "_v" = $4',
      'SELECT "_v" FROM "conformance_counters" WHERE "scope" = $1 AND "shard" = $2 FOR UPDATE',
      'INSERT INTO "conformance_counters" ("scope", "shard", "hits", "_v") VALUES ($1, $2, $3, $4) ON CONFLICT ("scope", "shard") DO UPDATE SET "hits" = "conformance_counters"."hits" + $5, "_v" = "conformance_counters"."_v" + $6',
    ]);
  });

  const tagged = {
    id: "a",
    grp: "g",
    score: 1,
    ratio: null,
    flag: false,
    label: null,
    tags: ["x", "y"],
    payload: null,
    note: null,
    _v: 0,
  };

  it("adds an inserted row's index table entries without deleting any, and replaces them on a patch or a delete", async () => {
    const { statements, adapter } = recorder("sqlite");
    const entries = () =>
      statements
        .map(({ sql }) => sql)
        .filter((sql) => sql.includes('"conformance_items__byTag"'));
    const add =
      'INSERT INTO "conformance_items__byTag" ("tags", "score", "id") VALUES (?, ?, ?)';
    const clear = 'DELETE FROM "conformance_items__byTag" WHERE "id" = ?';

    await adapter.write([
      { type: "insert", table: conformanceItems, row: tagged },
    ]);
    expect(entries()).toEqual([add, add]);

    statements.length = 0;
    await adapter.write([
      {
        type: "patch",
        table: conformanceItems,
        key: ["a"],
        set: { tags: ["z"] },
        guard: { v: 0 },
        previous: tagged,
      },
    ]);
    expect(entries()).toEqual([clear, add]);

    statements.length = 0;
    await adapter.write([
      {
        type: "delete",
        table: conformanceItems,
        key: ["a"],
        guard: { v: 1 },
        previous: { ...tagged, tags: ["z"], _v: 1 },
      },
    ]);
    expect(entries()).toEqual([clear]);
  });

  it("inserts a row in a batch write without scanning an index table", async () => {
    const db = new DatabaseSync(":memory:");
    const executor = sqliteBatchExecutor(db);
    const written: SqlStatement[] = [];
    const adapter = createSqlAdapter({
      executor: {
        ...executor,
        batch: (statements) => {
          written.push(...statements);
          return executor.batch!(statements);
        },
      },
    });
    await adapter.migrations!.apply([conformanceItems, WRITE_GUARD_TABLE]);
    await expect(
      adapter.write([{ type: "insert", table: conformanceItems, row: tagged }]),
    ).resolves.toEqual({ ok: true });

    // D1 bills every row a statement reads, and an index table grows with
    // every row inserted.
    const plan: string[] = [];
    for (const { sql, params } of written) {
      const steps = await executor.execute({
        sql: `EXPLAIN QUERY PLAN ${sql}`,
        params,
      });
      plan.push(...steps.rows.map(({ detail }) => String(detail)));
    }
    expect(plan.filter((step) => step.startsWith("SCAN conformance_"))).toEqual(
      [],
    );
    const rows = await adapter.query(conformanceItems, {
      index: "byTag",
      eq: ["y"],
      order: "asc",
      limit: 10,
    });
    expect(rows.map(({ id }) => id)).toEqual(["a"]);
    db.close();
  });

  it("indexes a retention column that no index or key already leads with", () => {
    const index = (table: PhysicalTable) =>
      createTableStatements("postgresql", [table]).filter((statement) =>
        statement.includes("__retention"),
      );
    expect(index(conformanceExpiring)).toEqual([
      'CREATE INDEX IF NOT EXISTS "conformance_expiring__retention" ON "conformance_expiring" ("at", "id")',
    ]);
    // An index or a key that starts with the column serves a prune already.
    const led = (retention: PhysicalTable["retention"]) =>
      index({ ...conformanceCounters, retention });
    expect(led({ column: "scope", ms: 1 })).toEqual([]);
    expect(
      index({
        ...conformanceExpiring,
        indexes: [{ name: "byAt", eq: ["at"], sort: [] }],
      }),
    ).toEqual([]);
    expect(led({ column: "hits", ms: 1 })).toEqual([
      'CREATE INDEX IF NOT EXISTS "conformance_counters__retention" ON "conformance_counters" ("hits", "scope", "shard")',
    ]);
  });

  it("walks expired rows in the order of the index that leads with the retention column", () => {
    const events: PhysicalTable = {
      ...conformanceExpiring,
      columns: [
        ...conformanceExpiring.columns,
        { name: "received", type: "integer", nullable: false },
      ],
      indexes: [{ name: "byAt", eq: ["at"], sort: ["received"] }],
    };
    const [postgres] = pruneStatements("postgresql", events, "", 10).map(
      (render) => render(() => "$1"),
    );
    expect(postgres).toBe(
      'DELETE FROM "conformance_expiring" WHERE ("conformance_expiring"."at", "conformance_expiring"."received", "conformance_expiring"."id") <= (SELECT b."at", b."received", b."id" FROM (SELECT i."at", i."received", i."id" FROM "conformance_expiring" i WHERE i."at" <= $1 ORDER BY i."at" ASC, i."received" ASC, i."id" ASC LIMIT 10) b ORDER BY b."at" DESC, b."received" DESC, b."id" DESC LIMIT 1) AND "conformance_expiring"."at" <= $1',
    );
    const [entries, rows] = pruneStatements(
      "mysql",
      conformanceExpiring,
      "",
      10,
    ).map((render) => render(() => "?"));
    expect(entries).toBe(
      "DELETE e FROM `conformance_expiring__byTag` e JOIN (SELECT i.`at`, i.`id` FROM `conformance_expiring` i WHERE i.`at` <= ? ORDER BY i.`at` ASC, i.`id` ASC LIMIT 10) d ON e.`id` = d.`id`",
    );
    expect(rows).toBe(
      "DELETE FROM `conformance_expiring` WHERE `at` <= ? ORDER BY `at`, `id` LIMIT 10",
    );
  });

  it.each(["PGlite", "SQLite"] as const)(
    "prunes expired rows with their index table entries on %s",
    async (engine) => {
      const sqlite = engine === "SQLite" ? new DatabaseSync(":memory:") : null;
      tests += 1;
      const executor = sqlite ? sqliteExecutor(sqlite) : pgliteExecutor(pglite);
      const prefix = sqlite ? "" : `t${tests}_`;
      const adapter = createSqlAdapter({ executor, tablePrefix: prefix });
      await adapter.migrations!.apply([conformanceExpiring]);
      await adapter.write(
        [5, 10, 20, null].map((at, position) => ({
          type: "insert",
          table: conformanceExpiring,
          row: { id: `r${position}`, grp: "g", at, tags: ["a", "b"], _v: 0 },
        })),
      );
      const count = async (name: string) =>
        Number(
          (
            await executor.execute({
              sql: `SELECT COUNT(*) AS n FROM "${prefix}${name}"`,
              params: [],
            })
          ).rows[0]!.n,
        );

      expect(await adapter.prune!(conformanceExpiring, 10, 500)).toBe(2);
      expect(await count("conformance_expiring")).toBe(2);
      // Each row had two tag entries; the pruned rows' went with them.
      expect(await count("conformance_expiring__byTag")).toBe(4);
      sqlite?.close();
    },
  );

  it.each([
    ["SQLite", "transaction"],
    ["SQLite", "batch"],
    ["PGlite", "transaction"],
    ["PGlite", "batch"],
  ] as const)(
    "reads no table whole to insert, update, or read rows, or to prune them on SQLite, on %s (%s)",
    async (engine, mode) => {
      const sqlite = engine === "SQLite" ? new DatabaseSync(":memory:") : null;
      const pg = sqlite ? null : new PGlite();
      // Small tables plan as production-sized ones: no sequential scan.
      await pg?.exec("SET enable_seqscan = off");
      const base = sqlite
        ? (mode === "batch" ? sqliteBatchExecutor : sqliteExecutor)(sqlite)
        : (mode === "batch" ? pgliteBatchExecutor : pgliteExecutor)(pg!);
      /** Statements that read a table or an index whole, with the step. */
      const scans: string[] = [];
      let counting = false;
      /** Each index's leading column, which a read must bound to seek. */
      const leading = new Map<string, string>();
      /**
       * Each plan step that walks a table or an index whole, but for an
       * ordered read its LIMIT bounds. PostgreSQL also matches an index on a
       * later column, which still walks the whole index.
       */
      const explain = async (
        connection: SqlConnection,
        statement: SqlStatement,
      ) => {
        if (!counting) return;
        const bounded = /^SELECT\b.* LIMIT \d+$/su.test(statement.sql);
        if (sqlite) {
          const { rows } = await connection.execute({
            ...statement,
            sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
          });
          const details = rows.map(({ detail }) => String(detail));
          // A subquery's own rows, which that subquery's reads bound.
          const derived = details.flatMap(
            (detail) => /^(?:CO-ROUTINE|MATERIALIZE) (\S+)/u.exec(detail) ?? [],
          );
          for (const detail of details) {
            const scan = /^SCAN (\S+)( USING .*INDEX)?/u.exec(detail);
            // A table-valued function (json_each) walks one row's value.
            if (
              scan &&
              !detail.includes(" VIRTUAL TABLE") &&
              scan[1] !== "CONSTANT" &&
              !derived.includes(scan[1]!) &&
              !(scan[2] && bounded)
            ) {
              scans.push(`${statement.sql} -- ${detail}`);
            }
          }
          return;
        }
        const { rows } = await connection.execute({
          ...statement,
          sql: `EXPLAIN (FORMAT JSON) ${statement.sql}`,
        });
        interface PlanNode {
          readonly "Node Type": string;
          readonly "Relation Name"?: string;
          readonly "Index Name"?: string;
          readonly "Index Cond"?: string;
          readonly Plans?: readonly PlanNode[];
        }
        const steps: PlanNode[] = [];
        const walk = (node: PlanNode) => {
          steps.push(node);
          for (const child of node.Plans ?? []) walk(child);
        };
        walk((rows[0]!["QUERY PLAN"] as [{ Plan: PlanNode }])[0].Plan);
        for (const step of steps) {
          const type = step["Node Type"];
          const index = step["Index Name"];
          let whole = type === "Seq Scan";
          if (index !== undefined) {
            if (!leading.has(index)) {
              const { rows: found } = await connection.execute({
                sql: "SELECT a.attname FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[0] WHERE c.relname = $1",
                params: [index],
              });
              leading.set(index, String(found[0]!.attname));
            }
            const column = leading.get(index)!;
            // `((id)::text = 'a'::text)` reads `id = 'a'`.
            const cond = step["Index Cond"]
              ?.replaceAll(/::[a-z]+(?: precision)?/gu, "")
              .replaceAll(/[()"]/gu, "");
            whole =
              cond === undefined
                ? !bounded
                : !new RegExp(`(?:^| )(?:\\w+\\.)?${column} [=<>]`, "u").test(
                    cond,
                  );
          }
          if (whole) {
            scans.push(
              `${statement.sql} -- ${type} on ${step["Relation Name"] ?? index}${index ? ` using ${index} (${step["Index Cond"]})` : ""}`,
            );
          }
        }
      };
      const watch = (connection: SqlConnection): SqlConnection => ({
        async execute(statement) {
          await explain(connection, statement);
          return connection.execute(statement);
        },
      });
      const executor: SqlExecutor = {
        ...base,
        execute: watch(base).execute,
        transaction: (fn) => base.transaction((tx) => fn(watch(tx))),
        ...(base.batch && {
          async batch(statements) {
            for (const statement of statements) {
              await explain(base, statement);
            }
            return base.batch!(statements);
          },
        }),
      };
      const tables = [
        conformanceItems,
        conformanceCounters,
        conformanceExpiring,
      ];
      const adapter = createSqlAdapter({ executor });
      await adapter.migrations!.apply(
        mode === "batch" ? [...tables, WRITE_GUARD_TABLE] : tables,
      );
      const item = (id: string, grp: string, tags: string[]) => ({
        id,
        grp,
        score: 1,
        ratio: null,
        flag: false,
        label: null,
        tags,
        payload: null,
        note: null,
        _v: 0,
      });
      // Rows no op below touches, so a statement that reads them all shows.
      const others = Array.from({ length: 40 }, (_, n) => `f${n}`);
      expect(
        await adapter.write(
          others.flatMap((id): WriteOp[] => [
            {
              type: "insert",
              table: conformanceItems,
              row: item(id, "f", ["f", "g"]),
            },
            {
              type: "insert",
              table: conformanceExpiring,
              row: { id, grp: "f", at: null, tags: ["f", "g"], _v: 0 },
            },
          ]),
        ),
      ).toEqual({ ok: true });
      await pg?.exec("VACUUM ANALYZE");
      counting = true;

      expect(
        await adapter.write([
          {
            type: "insert",
            table: conformanceItems,
            row: item("a", "g", ["x"]),
          },
          { type: "insert", table: conformanceItems, row: item("b", "g", []) },
          {
            type: "insert",
            table: conformanceExpiring,
            row: { id: "e", grp: "g", at: 5, tags: ["x", "y"], _v: 0 },
          },
          {
            type: "increment",
            table: conformanceCounters,
            key: ["s", 0],
            by: { hits: 1 },
            init: { scope: "s", shard: 0, hits: 0, _v: 0 },
          },
        ]),
      ).toEqual({ ok: true });
      const [a] = await adapter.get(conformanceItems, [["a"]]);
      // A patch of a column outside every index keeps the row's entries.
      expect(
        await adapter.write([
          {
            type: "patch",
            table: conformanceItems,
            key: ["a"],
            set: { note: "patched" },
            guard: { v: 0 },
            previous: a!,
          },
          {
            type: "check",
            table: conformanceItems,
            key: ["b"],
            guard: { v: 0 },
          },
        ]),
      ).toEqual({ ok: true });
      for (const index of conformanceItems.indexes) {
        await adapter.query(conformanceItems, {
          index: index.name,
          eq: index.eq.map((column) =>
            column === "tags" ? "x" : column === "flag" ? false : "g",
          ),
          order: "asc",
          limit: 10,
        });
      }
      if (sqlite) {
        expect(await adapter.prune!(conformanceExpiring, 10, 500)).toBe(1);
      }

      expect(scans).toEqual([]);
      sqlite?.close();
      await pg?.close();
    },
  );

  it("classifies constraint and transient driver errors", () => {
    const withCode = (fields: Record<string, unknown>) =>
      Object.assign(new Error("driver"), fields);
    expect(classifySqlError(withCode({ code: "23505" }))).toBe("constraint");
    expect(classifySqlError(withCode({ errno: 1062 }))).toBe("constraint");
    expect(classifySqlError(withCode({ errcode: 2067 }))).toBe("constraint");
    expect(classifySqlError(withCode({ code: "40P01" }))).toBe("retry");
    expect(classifySqlError(withCode({ errno: 1213 }))).toBe("retry");
    expect(classifySqlError(withCode({ code: "SQLITE_BUSY" }))).toBe("retry");
    expect(
      classifySqlError(
        new Error("wrapped", { cause: withCode({ code: "40001" }) }),
      ),
    ).toBe("retry");
    expect(classifySqlError(withCode({ code: "ECONNRESET" }))).toBeUndefined();
  });
});
