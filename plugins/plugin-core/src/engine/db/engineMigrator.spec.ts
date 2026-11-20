import { DatabaseSync } from "node:sqlite";

import { sqliteExecutor } from "@hot-updater/test-utils/node";
import { describe, expect, it } from "vitest";

import { createSqlAdapter } from "../database/sql/sqlAdapter";
import { coreSettings, coreTarget, createEngineDatabase } from "./coreDatabase";
import { migrateCoreSchema } from "./coreDatabase";

/** Core's tables as a 1.2 prerelease left them, its settings recorded: no labels. */
const prerelease = async () => {
  const database = new DatabaseSync(":memory:");
  const adapter = createSqlAdapter({ executor: sqliteExecutor(database) });
  await migrateCoreSchema(adapter, "sqlite", []);
  database.exec(
    'DROP INDEX "releases_byLabel"; ALTER TABLE "releases" DROP COLUMN "label"; DROP TABLE "label_sequences"',
  );
  return {
    database,
    migrator: createEngineDatabase({ name: "sqlite", adapter }).createMigrator!(
      coreTarget,
    ),
  };
};

const columns = (database: DatabaseSync, table: string) =>
  database
    .prepare("SELECT name FROM pragma_table_info(?)")
    .all(table)
    .map(({ name }) => name);

describe("the engine migrator over a SQL adapter", () => {
  it("adds a late column to a database whose settings already match, with its table and index", async () => {
    const { database, migrator } = await prerelease();

    const pending = await migrator.migrateToLatest();
    expect(pending.operations).toEqual([
      { type: "custom", description: "Add column: releases.label" },
      {
        type: "custom",
        description: "Create the tables and indexes the database lacks",
      },
    ]);
    await pending.execute();

    expect(columns(database, "releases")).toContain("label");
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('releases_byLabel', 'label_sequences') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: "label_sequences" }, { name: "releases_byLabel" }]);
    await expect(migrator.migrateToLatest()).resolves.toMatchObject({
      operations: [],
    });
    expect(
      database
        .prepare(
          "SELECT value FROM private_hot_updater_settings WHERE key = 'schema.core'",
        )
        .get(),
    ).toEqual({ value: coreSettings["schema.core"] });
  });

  it("adds it before creating its index when an earlier release's settings move", async () => {
    const { database, migrator } = await prerelease();
    database.exec(
      "UPDATE private_hot_updater_settings SET value = '1.0.0' WHERE key = 'schema.core'",
    );

    const pending = await migrator.migrateToLatest();
    expect(pending.operations[0]).toEqual({
      type: "custom",
      description: "Add column: releases.label",
    });
    await pending.execute();

    expect(columns(database, "releases")).toContain("label");
    await expect(migrator.migrateToLatest()).resolves.toMatchObject({
      operations: [],
    });
  });
});
