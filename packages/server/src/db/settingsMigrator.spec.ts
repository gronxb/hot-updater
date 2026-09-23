import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { checkSchemaFence, SETTINGS_TABLE } from "../database/fence";
import { createSqlAdapter } from "../database/sql/sqlAdapter";
import { createTableStatements } from "../database/sql/sqlSchema";
import { sqliteExecutor } from "../database/sql/sqlTestExecutors";
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

  it("asks for the ORM's tables first, refuses a database from before the engine, and rethrows other failures", async () => {
    await expect(
      migratorOver(new DatabaseSync(":memory:")).migrateToLatest(),
    ).rejects.toThrow("the ORM's push");

    const legacy = new DatabaseSync(":memory:");
    legacy.exec(
      "CREATE TABLE private_hot_updater_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO private_hot_updater_settings VALUES ('schema.core', '1.0.0');",
    );
    await expect(migratorOver(legacy).migrateToLatest()).rejects.toMatchObject({
      setting: { key: "schema.engine", expected: "1", found: null },
    });

    const closed = new DatabaseSync(":memory:");
    closed.close();
    await expect(migratorOver(closed).migrateToLatest()).rejects.toThrow(
      "database is not open",
    );
  });
});
