import { DatabaseSync, type SqliteValue } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, SqliteDialect } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { bundlePatchesV031, bundlesV031 } from "../schema/v0_31_0";
import { createDatabasePluginCore } from "./databasePluginCore";
import { createKyselyMigrator } from "./fixedMigrator";
import { createTableStatement } from "./schema/sql";
import { createV036AlterSql } from "./schema/sqlMigrations";
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

const createNodeSqliteV031DatabaseWithPatch = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  database.exec("pragma foreign_keys = on");
  database.exec(createTableStatement(bundlesV031, "sqlite"));
  database.exec(createTableStatement(bundlePatchesV031, "sqlite"));
  database.exec(`
    create table private_hot_updater_settings (
      key text primary key,
      value text not null
    );
    insert into bundles (
      id, platform, should_force_update, enabled, file_hash, channel,
      storage_uri, target_app_version
    ) values
      ('bundle-1', 'ios', 0, 1, 'hash-1', 'production', 's3://bundle-1', '1.0.0'),
      ('bundle-2', 'ios', 0, 1, 'hash-2', 'production', 's3://bundle-2', '1.0.0');
    insert into bundle_patches (
      id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
      patch_storage_uri
    ) values (
      'patch-1', 'bundle-2', 'bundle-1', 'hash-1', 'patch-hash',
      's3://patch-1'
    );
    insert into private_hot_updater_settings (key, value)
    values ('version', '0.31.0');
  `);
  return database;
};

const sqlitePatchRow = {
  id: "patch-1",
  bundle_id: "bundle-2",
  base_bundle_id: "bundle-1",
  base_file_hash: "hash-1",
  patch_file_hash: "patch-hash",
  patch_storage_uri: "s3://patch-1",
  order_index: 0,
} as const;

describe("createKyselyMigrator", () => {
  const databases: PGlite[] = [];
  const kyselyInstances: Kysely<SettingsDatabase>[] = [];

  afterEach(async () => {
    for (const kysely of kyselyInstances.splice(0)) await kysely.destroy();
    for (const database of databases.splice(0)) await database.close();
  });

  it("includes the schema version row in fresh standalone SQL", async () => {
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

    const migration = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: false,
    });

    const sql = migration.getSQL?.();

    expect(sql).toContain(
      "insert into private_hot_updater_settings (key, value) values ('schema.core', '0.37.0')",
    );
    expect(sql).not.toContain("values ('version'");
    expect(sql).toContain("bundle_events");
  });

  it.each(["0.36.0", "0.37.0", "0.38.0"])(
    "records Core readiness without rewriting legacy version %s",
    async (legacyVersion) => {
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
        create table extension_owned_records (
          id text primary key,
          value text not null
        );
        insert into private_hot_updater_settings (key, value)
        values ('version', '${legacyVersion}');
        insert into extension_owned_records (id, value)
        values ('extension-1', 'preserve-me');
      `);
      const migrator = createKyselyMigrator({
        db: kysely,
        provider: "postgresql",
      });

      await expect(migrator.getVersion()).resolves.toBe(
        legacyVersion === "0.36.0" ? "0.36.0" : "0.37.0",
      );
      await (
        await migrator.migrateToLatest({
          mode: "from-schema",
          updateSettings: true,
        })
      ).execute();

      const settings = await database.query<{
        readonly key: string;
        readonly value: string;
      }>("select key, value from private_hot_updater_settings order by key");
      expect(settings.rows).toEqual([
        { key: "schema.core", value: "0.37.0" },
        { key: "version", value: legacyVersion },
      ]);
      const extensionRows = await database.query<{
        readonly id: string;
        readonly value: string;
      }>("select id, value from extension_owned_records");
      expect(extensionRows.rows).toEqual([
        { id: "extension-1", value: "preserve-me" },
      ]);
      await expect(migrator.getVersion()).resolves.toBe("0.37.0");
    },
  );

  it.each([
    {
      name: "Core marker",
      coreValue: new Uint8Array([0xff]),
      legacyValue: undefined,
      invalidKey: "schema.core",
    },
    {
      name: "legacy marker",
      coreValue: undefined,
      legacyValue: new Uint8Array([0xff]),
      invalidKey: "version",
    },
    {
      name: "Core marker beside a valid legacy marker",
      coreValue: new Uint8Array([0xff]),
      legacyValue: "0.38.0",
      invalidKey: "schema.core",
    },
    {
      name: "legacy marker beside a current Core marker",
      coreValue: "0.37.0",
      legacyValue: new Uint8Array([0xff]),
      invalidKey: "version",
    },
  ])(
    "rejects a corrupt $name",
    async ({ coreValue, legacyValue, invalidKey }) => {
      const database = new DatabaseSync(":memory:");
      database.exec(`
        create table private_hot_updater_settings (
          key text primary key,
          value text not null
        );
      `);
      const insertSetting = database.prepare(
        "insert into private_hot_updater_settings (key, value) values (?, ?)",
      );
      if (coreValue !== undefined) insertSetting.run("schema.core", coreValue);
      if (legacyValue !== undefined) insertSetting.run("version", legacyValue);
      const kysely = createNodeSqliteKysely(database);
      kyselyInstances.push(kysely);
      const migrator = createKyselyMigrator({ db: kysely, provider: "sqlite" });

      await expect(migrator.getVersion()).rejects.toThrow(
        `Invalid Hot Updater schema setting: ${invalidKey}`,
      );
    },
  );

  it.each(["0.21.0", "0.29.0", "0.31.0", "0.36.0", "0.37.0", "0.38.0"])(
    "accepts known legacy version %s alongside a current Core marker",
    async (legacyVersion) => {
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
        insert into private_hot_updater_settings (key, value) values
          ('schema.core', '0.37.0'),
          ('version', '${legacyVersion}');
      `);
      const migrator = createKyselyMigrator({
        db: kysely,
        provider: "postgresql",
      });

      await expect(migrator.getVersion()).resolves.toBe("0.37.0");
      await expect(
        migrator.migrateToLatest({ mode: "from-schema" }),
      ).resolves.toMatchObject({ operations: [] });
    },
  );

  it("blocks unknown future legacy composite versions", async () => {
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
      values ('version', '0.39.0');
    `);
    const migrator = createKyselyMigrator({
      db: kysely,
      provider: "postgresql",
    });

    await expect(
      migrator.migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      }),
    ).rejects.toThrow("Unsupported Hot Updater schema version: 0.39.0");
  });

  it.each([
    {
      name: "future version",
      legacyValue: "0.39.0",
      error: "Unsupported Hot Updater schema version: 0.39.0",
    },
    {
      name: "unknown version",
      legacyValue: "unknown",
      error: "Unsupported Hot Updater schema version: unknown",
    },
    {
      name: "corrupt version",
      legacyValue: new Uint8Array([0xff]),
      error: "Invalid Hot Updater schema setting: version",
    },
  ])(
    "rejects a $name beside a current Core marker before reading bundle data",
    async ({ legacyValue, error }) => {
      const database = new DatabaseSync(":memory:");
      database.exec(`
        create table private_hot_updater_settings (
          key text primary key,
          value text not null
        );
      `);
      const insertSetting = database.prepare(
        "insert into private_hot_updater_settings (key, value) values (?, ?)",
      );
      insertSetting.run("schema.core", "0.37.0");
      insertSetting.run("version", legacyValue);
      const kysely = createNodeSqliteKysely(database);
      kyselyInstances.push(kysely);
      const migrator = createKyselyMigrator({
        db: kysely,
        provider: "sqlite",
      });
      const plugin = createInMemoryDatabasePlugin();
      const count = vi.spyOn(plugin.bundles, "count");
      const findMany = vi.spyOn(plugin.bundles, "findMany");
      const core = createDatabasePluginCore(plugin, async () => null, {
        beforeOperation: createSchemaReadinessChecker(
          "future-sql",
          () => migrator,
        ),
      });

      const result = core.api.getBundles({ limit: 1 });

      await expect(result).rejects.toThrow(error);
      expect(count).not.toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it.each(["standalone SQL", "direct execution"])(
    "preserves SQLite bundle patches during %s",
    async (mode) => {
      const database = createNodeSqliteV031DatabaseWithPatch();
      const kysely = createNodeSqliteKysely(database);
      kyselyInstances.push(kysely);
      const migrator = createKyselyMigrator({
        db: kysely,
        provider: "sqlite",
      });
      const migration = await migrator.migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      });

      if (mode === "standalone SQL") {
        const sql = migration.getSQL?.();
        if (typeof sql !== "string") throw new TypeError("Missing SQL");
        database.exec(sql);
      } else {
        await migration.execute();
      }

      expect(database.prepare("select * from bundle_patches").all()).toEqual([
        sqlitePatchRow,
      ]);
      expect(database.prepare("select channel from bundles").all()).toEqual([
        { channel: "production" },
        { channel: "production" },
      ]);
    },
  );

  it("rejects unknown schema versions before writing settings", async () => {
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
      values ('version', '0.20.0');
    `);
    const migrator = createKyselyMigrator({
      db: kysely,
      provider: "postgresql",
    });

    await expect(
      migrator.migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      }),
    ).rejects.toThrow("Unsupported Hot Updater schema version: 0.20.0");
    expect(await migrator.getVersion()).toBe("0.20.0");
  });

  it("keeps the unreleased v0.36 migration empty", () => {
    expect(createV036AlterSql("postgresql")).toEqual([]);
    expect(createV036AlterSql("mysql")).toEqual([]);
    expect(createV036AlterSql("sqlite")).toEqual([]);
  });
});
