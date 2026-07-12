import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it } from "vitest";

import { bundlesV021 } from "../schema/v0_21_0";
import { bundlesV029 } from "../schema/v0_29_0";
import { bundlePatchesV031, bundlesV031 } from "../schema/v0_31_0";
import { createKyselyMigrator } from "./fixedMigrator";
import { createTableStatement } from "./schema/sql";
import {
  createSchemaMigrationSql,
  createV036AlterSql,
} from "./schema/sqlMigrations";

interface SettingsDatabase {
  readonly private_hot_updater_settings: {
    readonly key: string;
    readonly value: string;
  };
}

describe("createKyselyMigrator", () => {
  const databases: PGlite[] = [];
  const kyselyInstances: Kysely<SettingsDatabase>[] = [];

  afterEach(async () => {
    for (const kysely of kyselyInstances.splice(0)) {
      await kysely.destroy();
    }
    for (const db of databases.splice(0)) {
      await db.close();
    }
  });

  it("includes the schema version row in fresh standalone SQL", async () => {
    const db = new PGlite();
    databases.push(db);
    const kysely = new Kysely<SettingsDatabase>({
      dialect: new PGliteDialect(db),
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
      "insert into private_hot_updater_settings (key, value) values ('version', '0.36.0')",
    );
    expect(migration.operations).not.toContainEqual(
      expect.objectContaining({
        sql: expect.stringContaining(
          "insert into private_hot_updater_settings",
        ),
      }),
    );
  });

  it("rejects unknown schema versions before writing settings", async () => {
    const db = new PGlite();
    databases.push(db);
    const kysely = new Kysely<SettingsDatabase>({
      dialect: new PGliteDialect(db),
    });
    kyselyInstances.push(kysely);
    await db.exec(`
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

    const version = await db.query<{ value: string }>(
      "select value from private_hot_updater_settings where key = 'version'",
    );
    expect(version.rows[0]?.value).toBe("0.20.0");
  });

  it("backfills channels before enforcing the v0.36.0 PostgreSQL foreign key", async () => {
    const db = new PGlite();
    databases.push(db);
    const kysely = new Kysely<SettingsDatabase>({
      dialect: new PGliteDialect(db),
    });
    kyselyInstances.push(kysely);
    await db.exec(`
      create table bundles (
        id uuid primary key,
        channel text not null
      );
      create table bundle_patches (
        id text primary key,
        bundle_id uuid not null references bundles(id) on delete cascade,
        base_bundle_id uuid not null references bundles(id) on delete cascade
      );
      create table private_hot_updater_settings (
        key text primary key,
        value text not null
      );
      insert into bundles (id, channel) values
        ('00000000-0000-0000-0000-000000000001', 'production'),
        ('00000000-0000-0000-0000-000000000002', 'production'),
        ('00000000-0000-0000-0000-000000000003', 'staging');
      insert into bundle_patches (id, bundle_id, base_bundle_id) values
        ('patch-1', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001');
      insert into private_hot_updater_settings (key, value)
      values ('version', '0.31.0');
    `);
    const migrator = createKyselyMigrator({
      db: kysely,
      provider: "postgresql",
    });

    const migration = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await migration.execute();

    const channels = await db.query<{ id: string }>(
      "select id from channels order by id",
    );
    expect(channels.rows).toEqual([{ id: "production" }, { id: "staging" }]);
    await expect(
      db.query(
        "insert into bundles (id, channel) values ('00000000-0000-0000-0000-000000000004', 'missing')",
      ),
    ).rejects.toThrow();
    await expect(
      db.query("delete from channels where id = 'production'"),
    ).rejects.toThrow();
    await expect(
      db.query(
        "insert into bundle_patches (id, bundle_id, base_bundle_id) values ('bad-owner', '00000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000001')",
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "insert into bundle_patches (id, bundle_id, base_bundle_id) values ('bad-base', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000099')",
      ),
    ).rejects.toThrow();
    await db.query(
      "delete from bundles where id = '00000000-0000-0000-0000-000000000003'",
    );
    const staging = await db.query<{ id: string }>(
      "select id from channels where id = 'staging'",
    );
    expect(staging.rows).toEqual([{ id: "staging" }]);
  });

  it("rebuilds SQLite bundles so the channel and patch foreign keys remain enforced", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("pragma foreign_keys = on");
    db.exec(createTableStatement(bundlesV031, "sqlite"));
    db.exec(createTableStatement(bundlePatchesV031, "sqlite"));
    db.exec(`
      insert into bundles (
        id, platform, should_force_update, enabled, file_hash, channel,
        storage_uri, target_app_version
      ) values
        ('bundle-1', 'ios', 0, 1, 'hash-1', 'production', 's3://bundle-1', '1.0.0'),
        ('bundle-2', 'ios', 0, 1, 'hash-2', 'production', 's3://bundle-2', '1.0.0'),
        ('bundle-3', 'ios', 0, 1, 'hash-3', 'staging', 's3://bundle-3', '1.0.0');
      insert into bundle_patches (
        id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
        patch_storage_uri
      ) values (
        'patch-1', 'bundle-2', 'bundle-1', 'hash-1', 'patch-hash',
        's3://patch-1'
      );
    `);

    for (const statement of createV036AlterSql("sqlite")) {
      db.exec(statement);
    }

    expect(db.prepare("select id from channels order by id").all()).toEqual([
      { id: "production" },
      { id: "staging" },
    ]);
    expect(() =>
      db.exec(`
        insert into bundles (
          id, platform, should_force_update, enabled, file_hash, channel,
          storage_uri, target_app_version
        ) values (
          'bundle-4', 'ios', 0, 1, 'hash-4', 'missing', 's3://bundle-4',
          '1.0.0'
        )
      `),
    ).toThrow();
    expect(() =>
      db.exec("delete from channels where id = 'production'"),
    ).toThrow();
    expect(() =>
      db.exec(
        "insert into bundle_patches (id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash, patch_storage_uri) values ('bad-owner', 'missing', 'bundle-1', 'hash-1', 'patch-hash', 's3://bad-owner')",
      ),
    ).toThrow();
    expect(() =>
      db.exec(
        "insert into bundle_patches (id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash, patch_storage_uri) values ('bad-base', 'bundle-1', 'missing', 'missing', 'patch-hash', 's3://bad-base')",
      ),
    ).toThrow();
    db.exec("delete from bundles where id = 'bundle-3'");
    expect(
      db.prepare("select id from channels where id = 'staging'").get(),
    ).toEqual({ id: "staging" });
    db.close();
  });

  it.each([
    ["0.21.0", bundlesV021],
    ["0.29.0", bundlesV029],
    ["0.31.0", bundlesV031],
  ])("upgrades a SQLite %s schema to v0.36.0", (version, bundlesTable) => {
    const db = new DatabaseSync(":memory:");
    db.exec("pragma foreign_keys = on");
    db.exec(createTableStatement(bundlesTable, "sqlite"));
    db.exec(`
      insert into bundles (
        id, platform, should_force_update, enabled, file_hash, channel,
        storage_uri, target_app_version
      ) values (
        'bundle-1', 'ios', 0, 1, 'hash-1', 'production', 's3://bundle-1',
        '1.0.0'
      )
    `);

    for (const statement of createSchemaMigrationSql(
      version,
      "0.36.0",
      "sqlite",
    )) {
      db.exec(statement);
    }

    expect(db.prepare("select id from channels").all()).toEqual([
      { id: "production" },
    ]);
    expect(db.prepare("pragma foreign_key_list('bundles')").all()).toEqual([
      expect.objectContaining({
        from: "channel",
        on_delete: "RESTRICT",
        table: "channels",
        to: "id",
      }),
    ]);
    db.close();
  });
});
