import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";

import { createBundleFixture } from "../../../test-utils/src/databaseTestFixtures";
import { createInProcessCoreApi } from "../core/api";
import {
  builtInSchema,
  builtInSettings,
  createEngineDatabase,
} from "../database/builtInDatabase";
import { createSqlAdapter } from "../database/sql/sqlAdapter";
import {
  createTableStatements,
  sqlTableShapes,
  type SqlTableShape,
} from "../database/sql/sqlSchema";
import {
  pgliteExecutor,
  sqliteExecutor,
} from "../database/sql/sqlTestExecutors";
import { generateEngineSql } from "./engineSql";

const sql = (dialect: "postgresql" | "mysql" | "sqlite") =>
  generateEngineSql(dialect, builtInSchema, builtInSettings);

describe("the shared SQL schema", () => {
  it("defaults engine columns, has no foreign keys, and writes the settings last", () => {
    const postgres = sql("postgresql");
    expect(
      postgres.find((statement) => statement.includes('"bundles" (')),
    ).toContain(
      '"_refs_releases_bundle_id" bigint NOT NULL DEFAULT 0, "_v" bigint NOT NULL DEFAULT 0',
    );
    for (const dialect of ["postgresql", "mysql", "sqlite"] as const) {
      expect(
        sql(dialect).some(
          (statement) =>
            statement.includes("FOREIGN KEY") ||
            statement.startsWith("ALTER TABLE"),
        ),
      ).toBe(false);
    }
    expect(
      postgres
        .slice(-4)
        .every((statement) =>
          statement.startsWith('INSERT INTO "private_hot_updater_settings"'),
        ),
    ).toBe(true);
    expect(sql("mysql").at(-1)).toContain("ON DUPLICATE KEY UPDATE");
  });

  it("describes each table as its DDL creates it, for ORM schema generators", () => {
    const tables = builtInSchema.tables;
    const names = (shapes: readonly SqlTableShape[]): string[] =>
      shapes.flatMap((shape) => [
        shape.name,
        ...names(
          shape.indexes.flatMap((index) =>
            index.kind === "table" ? [index.table] : [],
          ),
        ),
      ]);
    const created = createTableStatements("postgresql", tables).flatMap(
      (statement) =>
        statement.match(/^CREATE TABLE IF NOT EXISTS "(\w+)"/u)?.[1] ?? [],
    );
    const shapes = sqlTableShapes("postgresql", tables);
    expect(names(shapes)).toEqual(created);
    expect(created.some((name) => name.includes("__"))).toBe(true);
    expect(
      shapes
        .find((shape) => shape.name === "bundles")
        ?.columns.find((column) => column.name === "_v"),
    ).toEqual({ name: "_v", type: "bigint", notNull: true, default: 0 });
  });

  const pglite = new PGlite();
  afterAll(() => pglite.close());

  it("runs twice on PostgreSQL and passes the fence; the engine keeps references", async () => {
    for (let run = 0; run < 2; run += 1) {
      await pglite.exec(sql("postgresql").join(";\n"));
    }
    const core = createInProcessCoreApi(
      createEngineDatabase({
        name: "pglite",
        adapter: createSqlAdapter({ executor: pgliteExecutor(pglite) }),
      }).adapter,
    );
    const bundle = createBundleFixture("1");
    await core.deploy([
      {
        bundle,
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "1.0.0",
        },
      },
    ]);

    await expect(core.deleteBundles([bundle.id])).rejects.toThrow(
      "still referenced",
    );
    const { rows } = await pglite.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM information_schema.table_constraints WHERE constraint_type = 'FOREIGN KEY'",
    );
    expect(rows[0]!.count).toBe(0);
  });

  it("runs on SQLite and passes the fence", async () => {
    const db = new DatabaseSync(":memory:");
    for (const statement of sql("sqlite")) db.exec(statement);
    const core = createInProcessCoreApi(
      createEngineDatabase({
        name: "sqlite",
        adapter: createSqlAdapter({ executor: sqliteExecutor(db) }),
      }).adapter,
    );
    await expect(core.listChannels()).resolves.toEqual([]);
    db.close();
  });
});
