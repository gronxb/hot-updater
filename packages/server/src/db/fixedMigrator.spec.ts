import { DatabaseSync, type SqliteValue } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, SqliteDialect } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it } from "vitest";

import { bundlePatchesV031, bundlesV031 } from "../schema/v0_31_0";
import { createKyselyMigrator } from "./fixedMigrator";
import {
  executeMongoMigration,
  type MongoMigrationBackend,
} from "./mongoMigrationExecution";
import { createTableStatement } from "./schema/sql";
import { createV036AlterSql } from "./schema/sqlMigrations";

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

    expect(migration.getSQL?.()).toContain(
      "insert into private_hot_updater_settings (key, value) values ('version', '0.38.0')",
    );
  });

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

describe("MongoDB migration execution", () => {
  it("ensures collections and indexes before updating the version", async () => {
    const calls: string[] = [];
    const backend: MongoMigrationBackend = {
      ensureCollections: async () => void calls.push("collections"),
      ensureIndexes: async () => void calls.push("indexes"),
      updateVersion: async () => void calls.push("version"),
    };

    await executeMongoMigration({ backend, updateSettings: true });

    expect(calls).toEqual(["collections", "indexes", "version"]);
  });
});
