import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import type { PhysicalTable } from "@hot-updater/plugin-core/internal";
import {
  conformanceCounters,
  conformanceItems,
  setupDatabaseAdapterConformanceSuite,
} from "@hot-updater/test-utils";
import { afterAll, describe, expect, it } from "vitest";

import { builtInSchema } from "../builtInDatabase";
import {
  classifySqlError,
  createSqlAdapter,
  createTableStatements,
  type SqlExecutor,
  type SqlStatement,
  WRITE_GUARD_TABLE,
} from "./sqlAdapter";
import {
  pgliteBatchExecutor,
  pgliteExecutor,
  sqliteBatchExecutor,
  sqliteExecutor,
} from "./sqlTestExecutors";

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
    // every table the façade spans fits
    expect(() =>
      createTableStatements("mysql", builtInSchema.tables),
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
