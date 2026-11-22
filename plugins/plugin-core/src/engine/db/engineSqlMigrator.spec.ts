import { DatabaseSync } from "node:sqlite";

import { sqliteExecutor } from "@hot-updater/test-utils/node";
import { describe, expect, it } from "vitest";

import { coreSchema, coreSettings, coreTarget } from "./coreDatabase";
import { generateEngineSql } from "./engineSql";
import { createEngineSqlMigrator } from "./engineSqlMigrator";

describe("createEngineSqlMigrator over a later release's database", () => {
  const [table] = coreSchema.tables;

  /** Core's tables with `schema.core` as a later release recorded it, and one table gone. */
  const later = () => {
    const database = new DatabaseSync(":memory:");
    database.exec(
      generateEngineSql("sqlite", coreSchema, {
        ...coreSettings,
        "schema.core": "1.3.0",
      }).join(";"),
    );
    database.exec(`DROP TABLE "${table!.name}"`);
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

  it("refuses a database a newer release migrated, and writes nothing", async () => {
    const database = later();
    await expect(migratorOver(database).migrateToLatest()).rejects.toThrow(
      `kysely: the database was migrated by Hot Updater 1.3.0 (schema.core "1.3.0", this CLI's "${coreSettings["schema.core"]}"). Upgrade hot-updater to 1.3.0 or later; nothing was written.`,
    );
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get(table!.name),
    ).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT value FROM private_hot_updater_settings WHERE key = 'schema.core'",
        )
        .get(),
    ).toEqual({ value: "1.3.0" });
  });

  it("refuses with the default target too, as a migrator built without one does", async () => {
    const migrator = createEngineSqlMigrator({
      adapterName: "kysely",
      executor: sqliteExecutor(later()),
      schema: coreSchema,
      settings: coreSettings,
    });
    await expect(migrator.migrateToLatest()).rejects.toThrow(
      "Upgrade hot-updater to 1.3.0 or later; nothing was written.",
    );
  });
});
