import { DatabaseSync, type SqliteValue } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, SqliteDialect } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it } from "vitest";

import { bundlesV021 } from "../schema/v0_21_0";
import { bundlesV029 } from "../schema/v0_29_0";
import { bundlePatchesV031, bundlesV031 } from "../schema/v0_31_0";
import { createKyselyMigrator } from "./fixedMigrator";
import {
  executeMongoMigration,
  MONGO_CHANNEL_ID_PIPELINE,
  MONGO_NORMALIZE_CHANNEL_FIELDS_PIPELINE,
  type MongoMigrationBackend,
} from "./mongoMigrationExecution";
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

  it("normalizes channels before enforcing the v0.36.0 PostgreSQL foreign key", async () => {
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

    const channels = await db.query<{ id: string; name: string }>(
      "select id, name from channels order by id",
    );
    expect(channels.rows).toEqual([
      { id: "production", name: "production" },
      { id: "staging", name: "staging" },
    ]);
    await expect(
      db.query(
        "insert into bundles (id, channel_id) values ('00000000-0000-0000-0000-000000000004', 'missing')",
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "insert into channels (id, name) values ('duplicate', 'production')",
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
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'bundles'",
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toContain(
      "channel_id",
    );
    expect(columns.rows.map(({ column_name }) => column_name)).toContain(
      "channel",
    );
  });

  it("rolls back an interrupted PostgreSQL migration before retrying", async () => {
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
      create table channels (
        id varchar(255) primary key,
        name varchar(255) not null
      );
      create table private_hot_updater_settings (
        key text primary key,
        value text not null
      );
      insert into bundles (id, channel) values
        ('00000000-0000-0000-0000-000000000001', 'production');
      insert into channels (id, name) values ('production', 'renamed');
      insert into private_hot_updater_settings (key, value)
      values ('version', '0.31.0');
    `);
    const migrator = createKyselyMigrator({
      db: kysely,
      provider: "postgresql",
    });

    const interrupted = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await expect(interrupted.execute()).rejects.toThrow();

    const columnsAfterFailure = await db.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_name = 'bundles'
    `);
    expect(
      columnsAfterFailure.rows.map(({ column_name }) => column_name),
    ).not.toContain("channel_id");
    const indexesAfterFailure = await db.query<{ indexname: string }>(`
      select indexname from pg_indexes where indexname = 'channels_name_key'
    `);
    expect(indexesAfterFailure.rows).toEqual([]);
    expect(await migrator.getVersion()).toBe("0.31.0");

    await db.exec("delete from channels where id = 'production'");
    const retry = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await retry.execute();

    expect(await migrator.getVersion()).toBe("0.36.0");
    const migrated = await db.query<{ channel_id: string }>(
      "select channel_id from bundles",
    );
    expect(migrated.rows).toEqual([{ channel_id: "production" }]);
  });

  it("restores SQLite foreign keys and rolls back an interrupted rebuild", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("pragma foreign_keys = on");
    db.exec(createTableStatement(bundlesV031, "sqlite"));
    db.exec(createTableStatement(bundlePatchesV031, "sqlite"));
    db.exec(`
      create table private_hot_updater_settings (
        key text primary key,
        value text not null
      );
      create table bundles_v036 (id text primary key);
      insert into bundles (
        id, platform, should_force_update, enabled, file_hash, channel,
        storage_uri, target_app_version
      ) values (
        'bundle-1', 'ios', 0, 1, 'hash-1', 'production', 's3://bundle-1',
        '1.0.0'
      );
      insert into private_hot_updater_settings (key, value)
      values ('version', '0.31.0');
    `);
    const kysely = createNodeSqliteKysely(db);
    kyselyInstances.push(kysely);
    const migrator = createKyselyMigrator({ db: kysely, provider: "sqlite" });

    const interrupted = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await expect(interrupted.execute()).rejects.toThrow();

    expect(db.prepare("pragma foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(
      db
        .prepare(
          "select name from sqlite_master where type = 'table' and name = 'channels'",
        )
        .get(),
    ).toBeUndefined();
    expect(db.prepare("select channel from bundles").all()).toEqual([
      { channel: "production" },
    ]);
    expect(await migrator.getVersion()).toBe("0.31.0");

    db.exec("drop table bundles_v036");
    const retry = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await retry.execute();

    expect(await migrator.getVersion()).toBe("0.36.0");
    expect(db.prepare("pragma foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(db.prepare("select channel, channel_id from bundles").all()).toEqual(
      [{ channel: "production", channel_id: "production" }],
    );
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

    expect(
      db.prepare("select id, name from channels order by id").all(),
    ).toEqual([
      { id: "production", name: "production" },
      { id: "staging", name: "staging" },
    ]);
    expect(() =>
      db.exec(`
        insert into bundles (
          id, platform, should_force_update, enabled, file_hash, channel_id,
          storage_uri, target_app_version
        ) values (
          'bundle-4', 'ios', 0, 1, 'hash-4', 'missing', 's3://bundle-4',
          '1.0.0'
        )
      `),
    ).toThrow();
    expect(() =>
      db.exec(
        "insert into channels (id, name) values ('duplicate', 'production')",
      ),
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

    expect(db.prepare("select id, name from channels").all()).toEqual([
      { id: "production", name: "production" },
    ]);
    expect(db.prepare("pragma foreign_key_list('bundles')").all()).toEqual([
      expect.objectContaining({
        from: "channel_id",
        on_delete: "RESTRICT",
        table: "channels",
        to: "id",
      }),
    ]);
    db.close();
  });
});

describe("MongoDB channel migration", () => {
  it("resumes from channel_id without creating null channels after interruption", async () => {
    type BundleDocument = {
      channel?: unknown;
      channel_id?: unknown;
    };
    const bundles: BundleDocument[] = [
      { channel: "production" },
      { channel_id: "channel-staging" },
      { channel: null },
      {},
    ];
    const channels = new Map<string, string>([["channel-staging", "staging"]]);
    const channelReads: string[][] = [];
    let failIndexCreation = true;
    let version = "0.31.0";
    const backend: MongoMigrationBackend = {
      ensureCollections: async () => {},
      findChannelIds: async () => {
        const ids = [
          ...new Set(
            bundles
              .map(({ channel, channel_id }) => channel_id ?? channel)
              .filter(
                (value): value is string =>
                  typeof value === "string" && value.length > 0,
              ),
          ),
        ];
        channelReads.push(ids);
        return ids;
      },
      upsertChannel: async (id) => {
        if (!channels.has(id)) channels.set(id, id);
      },
      normalizeLegacyBundles: async () => {
        for (const bundle of bundles) {
          const channel =
            typeof bundle.channel === "string" && bundle.channel
              ? bundle.channel
              : bundle.channel_id;
          const channelId =
            typeof bundle.channel_id === "string" && bundle.channel_id
              ? bundle.channel_id
              : bundle.channel;
          if (typeof channel === "string" && channel) {
            bundle.channel = channel;
          }
          if (typeof channelId === "string" && channelId) {
            bundle.channel_id = channelId;
          }
        }
        for (const bundle of bundles) {
          if (typeof bundle.channel_id !== "string") continue;
          const channelName = channels.get(bundle.channel_id);
          if (channelName !== undefined) bundle.channel = channelName;
        }
      },
      ensureIndexes: async () => {
        if (!failIndexCreation) return;
        failIndexCreation = false;
        throw new Error("injected index creation failure");
      },
      updateVersion: async () => {
        version = "0.36.0";
      },
    };

    await expect(
      executeMongoMigration({ backend, updateSettings: true }),
    ).rejects.toThrow("injected index creation failure");
    expect(bundles[0]).toEqual({
      channel: "production",
      channel_id: "production",
    });
    expect(bundles[1]).toEqual({
      channel: "staging",
      channel_id: "channel-staging",
    });
    expect(version).toBe("0.31.0");

    await executeMongoMigration({ backend, updateSettings: true });

    expect(channelReads).toEqual([
      ["production", "channel-staging"],
      ["production", "channel-staging"],
    ]);
    expect([...channels.entries()]).toEqual([
      ["channel-staging", "staging"],
      ["production", "production"],
    ]);
    expect(version).toBe("0.36.0");
  });

  it("filters missing channels and falls back to normalized channel ids", () => {
    expect(MONGO_CHANNEL_ID_PIPELINE).toEqual([
      {
        $project: {
          channelId: { $ifNull: ["$channel_id", "$channel"] },
        },
      },
      {
        $match: {
          channelId: { $type: "string", $ne: "" },
        },
      },
      { $group: { _id: "$channelId" } },
    ]);
  });

  it("restores either channel field after a partially applied migration", () => {
    expect(MONGO_NORMALIZE_CHANNEL_FIELDS_PIPELINE).toEqual([
      {
        $set: {
          channel: {
            $cond: [
              {
                $and: [
                  { $eq: [{ $type: "$channel" }, "string"] },
                  { $ne: ["$channel", ""] },
                ],
              },
              "$channel",
              "$channel_id",
            ],
          },
          channel_id: {
            $cond: [
              {
                $and: [
                  { $eq: [{ $type: "$channel_id" }, "string"] },
                  { $ne: ["$channel_id", ""] },
                ],
              },
              "$channel_id",
              "$channel",
            ],
          },
        },
      },
    ]);
  });
});
