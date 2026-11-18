import { DatabaseSync } from "node:sqlite";

import { conformanceItems } from "@hot-updater/test-utils";
import { sqliteExecutor } from "@hot-updater/test-utils/node";
import { describe, expect, it } from "vitest";

import { SETTINGS_TABLE } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import type { SqlExecutor, SqlStatement } from "../database/sql/sqlAdapter";
import { sqlTableShapes, type SqlTableShape } from "../database/sql/sqlSchema";
import { coreSchema, coreSettings, coreTarget } from "./coreDatabase";
import { generateEngineSql } from "./engineSql";
import { createEngineSqlMigrator } from "./engineSqlMigrator";

const schema = {
  models: new Map(),
  tables: [conformanceItems],
} as unknown as ResolvedSchema;

/** Every table's declared indexes, by table name, index tables included. */
const declared = (shapes: readonly SqlTableShape[]): [string, string][] =>
  shapes.flatMap((shape) =>
    shape.indexes.flatMap((index) =>
      index.kind === "table"
        ? declared([index.table])
        : [[shape.name, index.name] as [string, string]],
    ),
  );

describe("createEngineSqlMigrator on MySQL", () => {
  it("finds a table's indexes under the lower-case names lower_case_table_names=1 reports", async () => {
    const statements: SqlStatement[] = [];
    // A server with lower_case_table_names=1: information_schema names
    // `conformance_items__byTag` in lower case, its indexes all present.
    const existing = declared(
      sqlTableShapes("mysql", [conformanceItems, SETTINGS_TABLE]),
    ).map(([t, i]) => ({ t: t.toLowerCase(), i }));
    const execute = async (statement: SqlStatement) => {
      statements.push(statement);
      if (statement.sql.includes("information_schema.statistics")) {
        return { rows: existing, changes: 0 };
      }
      return { rows: [], changes: 0 };
    };
    const executor: SqlExecutor = {
      dialect: "mysql",
      execute,
      transaction: (fn) => fn({ execute }),
    };
    const migrator = createEngineSqlMigrator({
      adapterName: "test",
      executor,
      schema,
      settings: { "schema.core": "1.2.0" },
    });
    await (await migrator.up()).execute();

    expect(
      statements.filter(({ sql }) => /^CREATE (UNIQUE )?INDEX/u.test(sql)),
    ).toEqual([]);
  });
});

describe("createEngineSqlMigrator over an earlier release's database", () => {
  /** Core's tables as 1.0 left them: no `native_builds`, no `releases_byScope`. */
  const earlier = () => {
    const database = new DatabaseSync(":memory:");
    database.exec(
      generateEngineSql("sqlite", coreSchema, {
        ...coreSettings,
        "schema.core": "1.0.0",
      }).join(";"),
    );
    database.exec('DROP TABLE native_builds; DROP INDEX "releases_byScope"');
    return database;
  };
  const migratorOver = (database: DatabaseSync) =>
    createEngineSqlMigrator({
      adapterName: "kysely",
      executor: sqliteExecutor(database),
      schema: coreSchema,
      settings: coreSettings,
      ordered: coreTarget.ordered,
    });

  it("lists only the tables and indexes it creates, and the settings it moves", async () => {
    const database = earlier();
    const migrator = migratorOver(database);
    const pending = await migrator.migrateToLatest();
    expect(pending.operations).toEqual([
      {
        type: "create-table",
        value: { ormName: "native_builds", columns: {} },
      },
      {
        type: "custom",
        description: "Create index: releases_byScope on releases",
      },
      {
        type: "custom",
        description: `Record schema.core 1.0.0 → ${coreSettings["schema.core"]}`,
      },
    ]);
    await pending.execute();
    await expect(migrator.migrateToLatest()).resolves.toMatchObject({
      operations: [],
    });
  });

  it("refuses a database a newer release migrated, and writes nothing", async () => {
    const database = earlier();
    database.exec(
      "UPDATE private_hot_updater_settings SET value = '1.3.0' WHERE key = 'schema.core'",
    );
    await expect(migratorOver(database).migrateToLatest()).rejects.toThrow(
      `kysely: the database was migrated by Hot Updater 1.3.0 (schema.core "1.3.0", this CLI's "${coreSettings["schema.core"]}"). Upgrade hot-updater to 1.3.0 or later; nothing was written.`,
    );
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'native_builds'")
        .get(),
    ).toBeUndefined();
  });
});
