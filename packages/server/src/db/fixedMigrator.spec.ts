import { DatabaseSync, type SqliteValue } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, SqliteDialect } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { createDatabasePluginCore } from "./databasePluginCore";
import { createKyselyMigrator } from "./fixedMigrator";
import { createSchemaReadinessChecker } from "./schemaReadiness";

interface SettingsDatabase {
  readonly private_hot_updater_settings: {
    readonly key: string;
    readonly value: string;
  };
}

const createNodeSqliteKysely = (
  database: DatabaseSync,
): Kysely<SettingsDatabase> =>
  new Kysely<SettingsDatabase>({
    dialect: new SqliteDialect({
      database: {
        close: () => database.close(),
        prepare: (sqlText) => {
          const statement = database.prepare(sqlText);
          return {
            reader: statement.columns().length > 0,
            all: (parameters) =>
              statement.all(...(parameters as SqliteValue[])),
            run: (parameters) => {
              const result = statement.run(...(parameters as SqliteValue[]));
              return {
                changes: result.changes,
                lastInsertRowid: result.lastInsertRowid,
              };
            },
            iterate: (parameters) =>
              statement.iterate(...(parameters as SqliteValue[])),
          };
        },
      },
    }),
  });

describe("Kysely migrator", () => {
  const databases: PGlite[] = [];
  const kyselyInstances: Kysely<SettingsDatabase>[] = [];

  afterEach(async () => {
    await Promise.all(kyselyInstances.splice(0).map((db) => db.destroy()));
    await Promise.all(databases.splice(0).map((db) => db.close()));
  });

  it("creates schema 1.0.0 from an empty database", async () => {
    const database = new PGlite();
    databases.push(database);
    const kysely = new Kysely<SettingsDatabase>({
      dialect: new PGliteDialect(database),
    });
    kyselyInstances.push(kysely);
    const migrator = createKyselyMigrator({
      db: kysely,
      provider: "postgresql",
    });

    await expect(migrator.getVersion()).resolves.toBeUndefined();
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    expect(result.operations.length).toBeGreaterThan(0);
    await result.execute();

    await expect(migrator.getVersion()).resolves.toBe("1.0.0");
    const tables = await database.query<{ tablename: string }>(`
      select tablename from pg_tables
      where schemaname = 'public'
      order by tablename
    `);
    expect(tables.rows.map(({ tablename }) => tablename)).toEqual(
      expect.arrayContaining([
        "bundles",
        "bundle_patches",
        "channels",
        "releases",
        "release_catalogs",
        "bundle_events",
        "client_access_keys",
        "private_hot_updater_settings",
      ]),
    );
  });

  it("is a no-op when schema.core is already 1.0.0", async () => {
    const database = new PGlite();
    databases.push(database);
    const kysely = new Kysely<SettingsDatabase>({
      dialect: new PGliteDialect(database),
    });
    kyselyInstances.push(kysely);
    const migrator = createKyselyMigrator({
      db: kysely,
      provider: "postgresql",
    });
    await (
      await migrator.migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      })
    ).execute();

    const result = await migrator.migrateToLatest({ mode: "from-schema" });
    expect(result.operations).toEqual([]);
    expect(result.getSQL?.()).toBe("");
  });

  it("ignores a leftover version marker when schema.core is 1.0.0", async () => {
    const database = new PGlite();
    databases.push(database);
    const kysely = new Kysely<SettingsDatabase>({
      dialect: new PGliteDialect(database),
    });
    kyselyInstances.push(kysely);
    const migrator = createKyselyMigrator({
      db: kysely,
      provider: "postgresql",
    });
    await (
      await migrator.migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      })
    ).execute();
    await database.exec(`
      insert into private_hot_updater_settings (key, value)
      values ('version', '0.36.0')
      on conflict (key) do update set value = excluded.value
    `);

    await expect(migrator.getVersion()).resolves.toBe("1.0.0");
    await expect(
      migrator.migrateToLatest({ mode: "from-schema" }),
    ).resolves.toMatchObject({ operations: [] });
  });

  it.each(["0.21.0", "0.36.0", "0.38.0", "0.39.0"])(
    "rejects in-place upgrade from schema %s",
    async (version) => {
      const database = new PGlite();
      databases.push(database);
      const kysely = new Kysely<SettingsDatabase>({
        dialect: new PGliteDialect(database),
      });
      kyselyInstances.push(kysely);
      await database.exec(`
        create table private_hot_updater_settings (
          key text primary key,
          value text not null
        );
        insert into private_hot_updater_settings (key, value)
        values ('schema.core', '${version}');
      `);
      const migrator = createKyselyMigrator({
        db: kysely,
        provider: "postgresql",
      });

      await expect(
        migrator.migrateToLatest({ mode: "from-schema" }),
      ).rejects.toThrow(`Hot Updater v1 cannot migrate schema ${version}`);
    },
  );

  it("rejects a corrupt schema.core value", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      create table private_hot_updater_settings (
        key text primary key,
        value text not null
      );
    `);
    database
      .prepare(
        "insert into private_hot_updater_settings (key, value) values (?, ?)",
      )
      .run("schema.core", new Uint8Array([0xff]));
    const kysely = createNodeSqliteKysely(database);
    kyselyInstances.push(kysely);
    const migrator = createKyselyMigrator({ db: kysely, provider: "sqlite" });

    await expect(migrator.getVersion()).rejects.toThrow(
      "Invalid Hot Updater schema setting: schema.core",
    );
  });

  it("blocks v0 schema readiness before reading bundle data", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      create table private_hot_updater_settings (
        key text primary key,
        value text not null
      );
    `);
    database
      .prepare(
        "insert into private_hot_updater_settings (key, value) values (?, ?)",
      )
      .run("schema.core", "0.36.0");
    const kysely = createNodeSqliteKysely(database);
    kyselyInstances.push(kysely);
    const migrator = createKyselyMigrator({
      db: kysely,
      provider: "sqlite",
    });
    const plugin = createInMemoryDatabasePlugin();
    const count = vi.spyOn(plugin.models.bundles, "count");
    const findMany = vi.spyOn(plugin.models.bundles, "findMany");
    const core = createDatabasePluginCore(plugin, async () => null, {
      beforeOperation: createSchemaReadinessChecker("v0-sql", () => migrator),
    });

    await expect(core.api.getBundles({ limit: 1 })).rejects.toThrow(
      "Hot Updater v1 cannot migrate schema 0.36.0",
    );
    expect(count).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});
