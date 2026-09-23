import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";

import {
  createBundleRowFixture,
  createChannelRowFixture,
  createReleaseRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import {
  createLegacyDatabasePlugin,
  legacyFacadeSchema,
  legacyFacadeSettings,
} from "../database/legacyFacade";
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

const sql = (dialect: "postgresql" | "mysql" | "sqlite", foreignKeys = true) =>
  generateEngineSql(dialect, legacyFacadeSchema, legacyFacadeSettings, {
    foreignKeys,
  });

describe("the shared SQL schema", () => {
  it("defaults engine columns, keeps restrict and cascade foreign keys, and writes the settings last", () => {
    const postgres = sql("postgresql");
    expect(
      postgres.find((statement) => statement.includes('"bundles" (')),
    ).toContain(
      '"_refs_releases_bundle_id" bigint NOT NULL DEFAULT 0, "_v" bigint NOT NULL DEFAULT 0',
    );
    const foreignKeys = postgres.filter((statement) =>
      statement.includes("FOREIGN KEY"),
    );
    expect(
      foreignKeys.map((statement) => statement.match(/ON DELETE \w+/u)?.[0]),
    ).toEqual([
      "ON DELETE CASCADE",
      "ON DELETE CASCADE",
      "ON DELETE RESTRICT",
      "ON DELETE RESTRICT",
    ]);
    expect(
      postgres
        .slice(-4)
        .every((statement) =>
          statement.startsWith('INSERT INTO "private_hot_updater_settings"'),
        ),
    ).toBe(true);

    const mysql = sql("mysql");
    expect(
      mysql.filter((statement) => statement.startsWith("ALTER TABLE")),
    ).toHaveLength(4);
    expect(mysql.at(-1)).toContain("ON DUPLICATE KEY UPDATE");
    expect(
      sql("sqlite").some((statement) => statement.includes("FOREIGN KEY")),
    ).toBe(false);
    expect(
      sql("postgresql", false).some((statement) =>
        statement.includes("FOREIGN KEY"),
      ),
    ).toBe(false);
  });

  it("describes each table as its DDL creates it, for ORM schema generators", () => {
    const tables = legacyFacadeSchema.tables;
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

  it("runs twice on PostgreSQL, enforces its foreign keys, and passes the fence", async () => {
    for (let run = 0; run < 2; run += 1) {
      await pglite.exec(sql("postgresql").join(";\n"));
    }
    const database = createLegacyDatabasePlugin({
      name: "pglite",
      adapter: createSqlAdapter({ executor: pgliteExecutor(pglite) }),
      fence: true,
    });
    const channel = createChannelRowFixture("production");
    const bundle = createBundleRowFixture("1");
    await database.models.channels.insert({
      row: channel,
      onConflict: "returnExisting",
    });
    await database.commit({
      changes: [
        { model: "bundles", operation: "insert", row: bundle },
        {
          model: "releases",
          operation: "insert",
          row: createReleaseRowFixture("1", bundle, channel),
        },
      ],
    });
    await expect(
      pglite.query(`DELETE FROM "bundles" WHERE "id" = $1`, [bundle.id]),
    ).rejects.toThrow("foreign key");
  });

  it("runs on SQLite and passes the fence", async () => {
    const db = new DatabaseSync(":memory:");
    for (const statement of sql("sqlite")) db.exec(statement);
    const database = createLegacyDatabasePlugin({
      name: "sqlite",
      adapter: createSqlAdapter({ executor: sqliteExecutor(db) }),
      fence: true,
    });
    await expect(database.models.channels.list({})).resolves.toEqual({
      channels: [],
    });
    db.close();
  });
});
