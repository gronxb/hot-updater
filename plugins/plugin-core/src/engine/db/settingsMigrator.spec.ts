import { DatabaseSync } from "node:sqlite";

import { sqliteExecutor } from "@hot-updater/test-utils/node";
import { describe, expect, it } from "vitest";

import { SETTINGS_TABLE, checkSchemaFence } from "../database/fence";
import { createSqlAdapter } from "../database/sql/sqlAdapter";
import { createTableStatements } from "../database/sql/sqlSchema";
import { createSettingsMigrator } from "./settingsMigrator";

const settings = { "schema.engine": "1", "schema.core": "1.0.0" };

const migratorOver = (database: DatabaseSync) =>
  createSettingsMigrator({
    adapterName: "orm",
    executor: sqliteExecutor(database),
    settings,
    applyTables: "the ORM's push",
  });

describe("the settings-only migrator", () => {
  it("writes only the settings rows once the ORM applied the tables, then has nothing left", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(createTableStatements("sqlite", [SETTINGS_TABLE]).join(";"));
    const migrator = migratorOver(database);

    const pending = await migrator.migrateToLatest();
    expect(pending.operations).toEqual([
      expect.objectContaining({ type: "custom" }),
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
    ).rejects.toThrow("the ORM's push");

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

describe("the settings-only migrator's guard", () => {
  it("refuses a database a newer release migrated, and writes nothing", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(createTableStatements("sqlite", [SETTINGS_TABLE]).join(";"));
    database.exec(
      "INSERT INTO private_hot_updater_settings VALUES ('schema.engine', '1', 0), ('schema.core', '1.3.0', 0)",
    );
    for (const updateSettings of [true, false]) {
      await expect(
        migratorOver(database).migrateToLatest({ updateSettings }),
      ).rejects.toThrow(
        'orm: the database was migrated by Hot Updater 1.3.0 (schema.core "1.3.0", this CLI\'s "1.0.0"). Upgrade hot-updater to 1.3.0 or later; nothing was written.',
      );
    }
    expect(
      database
        .prepare(
          "SELECT value FROM private_hot_updater_settings WHERE key = 'schema.core'",
        )
        .get(),
    ).toEqual({ value: "1.3.0" });
  });
});
