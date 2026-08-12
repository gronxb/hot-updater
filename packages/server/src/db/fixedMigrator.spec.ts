import { DatabaseSync, type SqliteValue } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, SqliteDialect } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { bundlePatchesV031, bundlesV031 } from "../schema/v0_31_0";
import { v0_37_0 } from "../schema/v0_37_0";
import { channelsV038 } from "../schema/v0_38_0";
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
      ('bundle-2', 'ios', 0, 1, 'hash-2', 'production', 's3://bundle-2', '1.0.0'),
      ('bundle-3', 'android', 0, 1, 'hash-3', 'Production', 's3://bundle-3', '1.0.0');
    insert into bundle_patches (
      id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
      patch_storage_uri
    ) values (
      'patch-1', 'bundle-2', 'bundle-1', 'hash-1', 'patch-hash',
      's3://patch-1'
    );
    insert into private_hot_updater_settings (key, value)
    values ('version', '0.31.0');
    create table bundle_audit (
      bundle_id text not null,
      message text
    );
    create index user_bundles_enabled_idx
      on bundles(enabled)
      where enabled = 1;
    create trigger user_bundles_message_audit
      after update of message on bundles
      begin
        insert into bundle_audit (bundle_id, message)
        values (new.id, new.message);
      end;
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
      "insert into private_hot_updater_settings (key, value) values ('schema.core', '0.38.0')",
    );
    expect(sql).not.toContain("values ('version'");
    expect(sql).toContain("bundle_events");
    expect(sql).toContain("channels");
    expect(sql).toContain("channel_id");
  });

  it.each(["0.38.0"])(
    "records current Core readiness without rewriting legacy version %s",
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

      await expect(migrator.getVersion()).resolves.toBe(legacyVersion);
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
        { key: "schema.core", value: "0.38.0" },
        { key: "version", value: legacyVersion },
      ]);
      const extensionRows = await database.query<{
        readonly id: string;
        readonly value: string;
      }>("select id, value from extension_owned_records");
      expect(extensionRows.rows).toEqual([
        { id: "extension-1", value: "preserve-me" },
      ]);
      await expect(migrator.getVersion()).resolves.toBe("0.38.0");
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
      legacyValue: "0.37.0",
      invalidKey: "schema.core",
    },
    {
      name: "legacy marker beside a current Core marker",
      coreValue: "0.38.0",
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
          ('schema.core', '0.38.0'),
          ('version', '${legacyVersion}');
      `);
      const migrator = createKyselyMigrator({
        db: kysely,
        provider: "postgresql",
      });

      await expect(migrator.getVersion()).resolves.toBe("0.38.0");
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
      insertSetting.run("schema.core", "0.38.0");
      insertSetting.run("version", legacyValue);
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
      expect(
        database.prepare("select channel from bundles order by id").all(),
      ).toEqual([
        { channel: "production" },
        { channel: "production" },
        { channel: "Production" },
      ]);
      const channels = database
        .prepare("select id, name from channels order by name")
        .all() as { readonly id: string; readonly name: string }[];
      expect(channels).toEqual([
        { id: expect.any(String), name: "Production" },
        { id: expect.any(String), name: "production" },
      ]);
      const channelIdsByName = new Map(
        channels.map(({ id, name }) => [name, id]),
      );
      expect(
        database
          .prepare(
            "select channel, channel_id from bundles order by channel, id",
          )
          .all(),
      ).toEqual([
        {
          channel: "Production",
          channel_id: channelIdsByName.get("Production"),
        },
        {
          channel: "production",
          channel_id: channelIdsByName.get("production"),
        },
        {
          channel: "production",
          channel_id: channelIdsByName.get("production"),
        },
      ]);
      const channelIdColumn = database
        .prepare("pragma table_info(bundles)")
        .all()
        .find((column) => column["name"] === "channel_id");
      expect(channelIdColumn).toMatchObject({ notnull: 1, type: "TEXT" });
      expect(
        database.prepare("pragma foreign_key_list(bundles)").all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: "channel_id",
            on_delete: "RESTRICT",
            table: "channels",
            to: "id",
          }),
        ]),
      );
      expect(() =>
        database
          .prepare("delete from channels where name = 'production'")
          .run(),
      ).toThrow();
      expect(
        database
          .prepare(
            "select name, type from sqlite_master where name in ('user_bundles_enabled_idx', 'user_bundles_message_audit') order by name",
          )
          .all(),
      ).toEqual([
        { name: "user_bundles_enabled_idx", type: "index" },
        { name: "user_bundles_message_audit", type: "trigger" },
      ]);
      database
        .prepare("update bundles set message = ? where id = ?")
        .run("migrated", "bundle-1");
      expect(database.prepare("select * from bundle_audit").all()).toEqual([
        { bundle_id: "bundle-1", message: "migrated" },
      ]);
    },
  );

  it("normalizes legacy PostgreSQL channels before enforcing constraints", async () => {
    const database = new PGlite();
    databases.push(database);
    const kysely = new Kysely<SettingsDatabase>({
      dialect: new PGliteDialect(database),
    });
    kyselyInstances.push(kysely);
    await database.exec(
      v0_37_0.tables
        .map((table) => createTableStatement(table, "postgresql"))
        .join(";\n"),
    );
    await database.exec(`
      insert into bundles (
        id, platform, should_force_update, enabled, file_hash, channel,
        storage_uri, target_app_version
      ) values
        ('00000000-0000-0000-0000-000000000001', 'ios', false, true,
         'hash-1', 'production', 's3://bundle-1', '1.0.0'),
        ('00000000-0000-0000-0000-000000000002', 'ios', false, true,
         'hash-2', 'production', 's3://bundle-2', '1.0.0'),
        ('00000000-0000-0000-0000-000000000003', 'android', false, true,
         'hash-3', 'beta', 's3://bundle-3', '1.0.0'),
        ('00000000-0000-0000-0000-000000000004', 'android', false, true,
         'hash-4', 'Production', 's3://bundle-4', '1.0.0');
      insert into private_hot_updater_settings (key, value)
      values ('schema.core', '0.37.0');
    `);
    const migrator = createKyselyMigrator({
      db: kysely,
      provider: "postgresql",
    });
    const migration = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    const statements = migration.operations.flatMap((operation) =>
      operation.type === "custom" && "sql" in operation ? [operation.sql] : [],
    );
    const validationIndex = statements.findIndex((statement) =>
      statement.includes("hot_updater_channel_backfill_is_complete"),
    );
    const notNullIndex = statements.findIndex((statement) =>
      statement.includes("alter column channel_id set not null"),
    );
    const foreignKeyIndex = statements.findIndex((statement) =>
      statement.includes("bundles_channel_id_fk"),
    );

    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(notNullIndex).toBeGreaterThan(validationIndex);
    expect(foreignKeyIndex).toBeGreaterThan(notNullIndex);

    await migration.execute();

    const channels = await database.query<{ id: string; name: string }>(
      "select id, name from channels order by name",
    );
    expect(channels.rows).toEqual([
      { id: expect.any(String), name: "Production" },
      { id: expect.any(String), name: "beta" },
      { id: expect.any(String), name: "production" },
    ]);
    const bundles = await database.query<{
      channel: string;
      channel_id: string;
      channel_name: string;
    }>(`
      select bundle.channel, bundle.channel_id, channel.name as channel_name
      from bundles as bundle
      join channels as channel on channel.id = bundle.channel_id
      order by bundle.id
    `);
    expect(bundles.rows).toHaveLength(4);
    expect(
      bundles.rows.every(
        ({ channel, channel_name }) => channel === channel_name,
      ),
    ).toBe(true);
    expect(new Set(bundles.rows.map(({ channel_id }) => channel_id))).toEqual(
      new Set(channels.rows.map(({ id }) => id)),
    );
    await expect(
      database.exec(
        "update bundles set channel_id = null where id = '00000000-0000-0000-0000-000000000001'",
      ),
    ).rejects.toThrow();
    await expect(
      database.exec(
        "update bundles set channel_id = 'missing' where id = '00000000-0000-0000-0000-000000000001'",
      ),
    ).rejects.toThrow();
    const production = channels.rows.find(({ name }) => name === "production")!;
    await expect(
      database.exec(`delete from channels where id = '${production.id}'`),
    ).rejects.toThrow();
    await database.exec(
      "insert into channels (id, name) values ('empty-channel', 'empty')",
    );
    await database.exec("delete from channels where id = 'empty-channel'");
    await expect(migrator.getVersion()).resolves.toBe("0.38.0");
  });

  it("accepts 255 Unicode code points and rejects 256 before advancing PostgreSQL", async () => {
    const validName = "😀".repeat(255);
    const invalidName = "😀".repeat(256);
    for (const [name, valid] of [
      [validName, true],
      [invalidName, false],
    ] as const) {
      const database = new PGlite();
      databases.push(database);
      const kysely = new Kysely<SettingsDatabase>({
        dialect: new PGliteDialect(database),
      });
      kyselyInstances.push(kysely);
      await database.exec(
        v0_37_0.tables
          .map((table) => createTableStatement(table, "postgresql"))
          .join(";\n"),
      );
      await database.query(
        `insert into bundles (
          id, platform, should_force_update, enabled, file_hash, channel,
          storage_uri, target_app_version
        ) values (
          '00000000-0000-0000-0000-000000000001', 'ios', false, true,
          'hash', $1, 's3://bundle', '1.0.0'
        )`,
        [name],
      );
      await database.exec(`
        insert into private_hot_updater_settings (key, value)
        values ('schema.core', '0.37.0')
      `);
      const migrator = createKyselyMigrator({
        db: kysely,
        provider: "postgresql",
      });
      const migration = await migrator.migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      });

      if (valid) {
        await migration.execute();
        const channels = await database.query<{ name: string }>(
          "select name from channels",
        );
        expect(channels.rows).toEqual([{ name: validName }]);
        await expect(migrator.getVersion()).resolves.toBe("0.38.0");
      } else {
        await expect(migration.execute()).rejects.toThrow(
          "hot_updater_channel_name_is_valid",
        );
        await expect(migrator.getVersion()).resolves.toBe("0.37.0");
      }
    }
  });

  it("enforces the 255-code-point Channel boundary on fresh SQLite schemas", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(createTableStatement(channelsV038, "sqlite"));
    const insert = database.prepare(
      "insert into channels (id, name) values (?, ?)",
    );

    expect(() => insert.run("id-255", "😀".repeat(255))).not.toThrow();
    expect(() => insert.run("id-256", "😀".repeat(256))).toThrow(
      "channels_name_length_check",
    );
    database.close();
  });

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
