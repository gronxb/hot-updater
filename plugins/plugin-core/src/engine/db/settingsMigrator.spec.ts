import { DatabaseSync } from "node:sqlite";

import { sqliteExecutor } from "@hot-updater/test-utils/node";
import { describe, expect, it } from "vitest";

import { SETTINGS_TABLE, checkSchemaFence } from "../database/fence";
import { createSqlAdapter } from "../database/sql/sqlAdapter";
import { createTableStatements } from "../database/sql/sqlSchema";
import { coreSchema } from "./coreDatabase";
import { createSettingsMigrator } from "./settingsMigrator";

const settings = { "schema.engine": "1", "schema.core": "1.0.0" };

const migratorOver = (database: DatabaseSync) =>
  createSettingsMigrator({
    adapterName: "orm",
    executor: sqliteExecutor(database),
    schema: coreSchema,
    settings,
    applyTables: "the ORM's push",
  });

/** Every table and index the ORM applies, as its push would. */
const applied = () => {
  const database = new DatabaseSync(":memory:");
  database.exec(
    createTableStatements("sqlite", [
      ...coreSchema.tables,
      SETTINGS_TABLE,
    ]).join(";"),
  );
  return database;
};

describe("the settings-only migrator", () => {
  it("writes only the settings rows once the ORM applied the tables, then has nothing left", async () => {
    const database = applied();
    const migrator = migratorOver(database);

    const pending = await migrator.migrateToLatest();
    expect(pending.operations).toEqual([
      {
        type: "custom",
        description: "Record schema.engine 1, schema.core 1.0.0",
      },
    ]);
    expect(pending.getSQL?.()).toContain("ON CONFLICT");
    await pending.execute();
    await expect(migrator.migrateToLatest()).resolves.toMatchObject({
      operations: [],
    });
    await expect(migrator.getVersion()).resolves.toBe("1.0.0");
    await expect(
      checkSchemaFence(
        createSqlAdapter({ executor: sqliteExecutor(database) }),
        "orm",
        settings,
      ),
    ).resolves.toBeUndefined();
  });

  it("asks for the ORM's tables first, refuses a v0 database, and rethrows other failures", async () => {
    await expect(
      migratorOver(new DatabaseSync(":memory:")).migrateToLatest(),
    ).rejects.toThrow(
      "orm: the Hot Updater tables are missing. Run `hot-updater db generate`, apply it with the ORM's push, then migrate again.",
    );

    const v0 = new DatabaseSync(":memory:");
    v0.exec(
      "CREATE TABLE private_hot_updater_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO private_hot_updater_settings VALUES ('version', '0.21.0');",
    );
    await expect(migratorOver(v0).migrateToLatest()).rejects.toThrow(
      "Hot Updater v1 cannot migrate schema 0.21.0 in place.",
    );

    const closed = new DatabaseSync(":memory:");
    closed.close();
    await expect(migratorOver(closed).migrateToLatest()).rejects.toThrow(
      "database is not open",
    );
  });
});

describe("the settings-only migrator's guards", () => {
  it("names the tables and indexes the ORM has yet to apply, and writes nothing", async () => {
    const database = applied();
    database.exec('DROP TABLE native_builds; DROP INDEX "releases_byScope"');
    await expect(migratorOver(database).migrateToLatest()).rejects.toThrow(
      "orm: the database lacks table native_builds and index releases_byScope. Run `hot-updater db generate`, apply it with the ORM's push, then migrate again.",
    );
    expect(
      database
        .prepare("SELECT count(*) AS n FROM private_hot_updater_settings")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("adds a late column and its index a migration file for an earlier release's database left out, then writes the settings", async () => {
    const database = applied();
    database.exec(
      'DROP INDEX "releases_byLabel"; ALTER TABLE "releases" DROP COLUMN "label"',
    );
    const migrator = migratorOver(database);

    const pending = await migrator.migrateToLatest();
    expect(pending.operations).toEqual([
      { type: "custom", description: "Add column: label to releases" },
      {
        type: "custom",
        description: "Create index: releases_byLabel on releases",
      },
      {
        type: "custom",
        description: "Record schema.engine 1, schema.core 1.0.0",
      },
    ]);
    await pending.execute();

    expect(
      database
        .prepare(
          "SELECT name FROM pragma_table_info('releases') WHERE name = 'label'",
        )
        .all(),
    ).toEqual([{ name: "label" }]);
    await expect(migrator.migrateToLatest()).resolves.toMatchObject({
      operations: [],
    });
  });

  it("refuses a database a newer release migrated, and writes nothing", async () => {
    const database = applied();
    database.exec(
      "INSERT INTO private_hot_updater_settings VALUES ('schema.engine', '1', 0), ('schema.core', '1.3.0', 0)",
    );
    await expect(migratorOver(database).migrateToLatest()).rejects.toThrow(
      'orm: the database was migrated by Hot Updater 1.3.0 (schema.core "1.3.0", this CLI\'s "1.0.0"). Upgrade hot-updater to 1.3.0 or later; nothing was written.',
    );
    expect(
      database
        .prepare(
          "SELECT value FROM private_hot_updater_settings WHERE key = 'schema.core'",
        )
        .get(),
    ).toEqual({ value: "1.3.0" });
  });
});
