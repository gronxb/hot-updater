import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHotUpdater } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { createMigrator } from "@hot-updater/server/db";
import { assertDockerComposeAvailable } from "@hot-updater/test-utils/node";
import { execa } from "execa";
import { Kysely, MysqlDialect, sql } from "kysely";
import { createPool } from "mysql2";
import { afterAll, beforeAll, expect, it } from "vitest";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

assertDockerComposeAvailable(
  "MySQL v0.38 migration tests require Docker Compose and a running daemon.",
);

const connection = {
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT) || 3307,
  user: process.env.MYSQL_USER || "hot_updater",
  password: process.env.MYSQL_PASSWORD || "hot_updater_dev",
};

const v037Statements = [
  `create table bundle_events (
    id char(36) primary key not null,
    type text not null,
    install_id text not null,
    user_id text,
    username text,
    from_bundle_id char(36) not null,
    to_bundle_id char(36) not null,
    platform text not null,
    app_version text not null,
    channel text not null,
    cohort text not null,
    update_strategy text not null,
    fingerprint_hash text,
    sdk_version text,
    received_at_ms double not null
  )`,
  "alter table bundle_events add constraint bundle_events_type_check check (type in ('UPDATE_APPLIED', 'RECOVERED'))",
  "alter table bundle_events add constraint bundle_events_update_strategy_check check (update_strategy in ('fingerprint', 'appVersion'))",
  "create index bundle_events_installed_bundle_idx on bundle_events(type(255), to_bundle_id, received_at_ms, id)",
  "create index bundle_events_recovered_bundle_idx on bundle_events(type(255), from_bundle_id, received_at_ms, id)",
  "create index bundle_events_install_idx on bundle_events(install_id(255), received_at_ms, id)",
  "create index bundle_events_user_id_idx on bundle_events(user_id(255), received_at_ms, id)",
  "create index bundle_events_username_idx on bundle_events(username(255), received_at_ms, id)",
  "create index bundle_events_cohort_idx on bundle_events(cohort(255), type(255), received_at_ms, id)",
  "create index bundle_events_received_at_idx on bundle_events(received_at_ms, id)",
] as const;

beforeAll(async () => {
  await execa("docker", ["compose", "up", "-d", "--wait"], {
    cwd: projectRoot,
  });
}, 120000);

afterAll(async () => {
  const admin = createPool({
    ...connection,
    user: "root",
    password: process.env.MYSQL_ROOT_PASSWORD || "hot_updater_root",
  }).promise();
  await admin.query(`drop database if exists \`hot_updater_v038_test\``);
  await admin.end();
});

it("preserves MySQL v0.37 rows and constraints while upgrading to v0.38", async () => {
  // Given
  const admin = createPool({
    ...connection,
    user: "root",
    password: process.env.MYSQL_ROOT_PASSWORD || "hot_updater_root",
  }).promise();
  await admin.query("drop database if exists `hot_updater_v038_test`");
  await admin.query("create database `hot_updater_v038_test`");
  await admin.query(
    "grant all privileges on `hot_updater_v038_test`.* to 'hot_updater'@'%'",
  );
  await admin.end();

  const pool = createPool({ ...connection, database: "hot_updater_v038_test" });
  const db = new Kysely({
    dialect: new MysqlDialect({
      pool,
    }),
  });

  try {
    await sql
      .raw(
        "create table private_hot_updater_settings (`key` varchar(255) primary key, value text not null)",
      )
      .execute(db);
    await sql
      .raw(
        "insert into private_hot_updater_settings (`key`, value) values ('version', '0.37.0')",
      )
      .execute(db);
    for (const statement of v037Statements) {
      await sql.raw(statement).execute(db);
    }
    await sql
      .raw(`
        insert into bundle_events (
          id, type, install_id, from_bundle_id, to_bundle_id, platform,
          app_version, channel, cohort, update_strategy, received_at_ms
        ) values (
          '00000000-0000-0000-0000-000000000001', 'UPDATE_APPLIED',
          'install', '00000000-0000-0000-0000-000000000010',
          '00000000-0000-0000-0000-000000000011', 'ios', '1.0.0',
          'production', 'cohort', 'appVersion', 1
        )
      `)
      .execute(db);

    // When
    const migrator = createMigrator(
      createHotUpdater({
        database: kyselyAdapter({ db, provider: "mysql" }),
      }),
    );
    const migration = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await migration.execute();

    // Then
    expect(await migrator.getVersion()).toBe("0.38.0");
    const rows = await sql<{
      readonly type: string;
      readonly from_bundle_id: string | null;
      readonly update_strategy: string | null;
    }>`select type, from_bundle_id, update_strategy from bundle_events`.execute(
      db,
    );
    expect(rows.rows).toEqual([
      {
        type: "UPDATE_APPLIED",
        from_bundle_id: "00000000-0000-0000-0000-000000000010",
        update_strategy: "appVersion",
      },
    ]);

    const indexes = await sql<{ readonly count: number }>`
      select count(distinct index_name) as count
      from information_schema.statistics
      where table_schema = 'hot_updater_v038_test'
        and table_name = 'bundle_events'
    `.execute(db);
    expect(Number(indexes.rows[0]?.count)).toBe(8);

    await sql
      .raw(`
        insert into bundle_events (
          id, type, install_id, from_bundle_id, to_bundle_id, platform,
          app_version, channel, cohort, update_strategy, received_at_ms
        ) values (
          '00000000-0000-0000-0000-000000000002', 'UNCHANGED',
          'install', null, '00000000-0000-0000-0000-000000000011',
          'ios', '1.0.0', 'production', 'cohort', null, 2
        )
      `)
      .execute(db);

    await expect(
      sql
        .raw(`
          insert into bundle_events (
            id, type, install_id, from_bundle_id, to_bundle_id, platform,
            app_version, channel, cohort, update_strategy, received_at_ms
          ) values (
            '00000000-0000-0000-0000-000000000003', 'UNCHANGED',
            'install', '00000000-0000-0000-0000-000000000010',
            '00000000-0000-0000-0000-000000000011', 'ios', '1.0.0',
            'production', 'cohort', 'fingerprint', 3
          )
        `)
        .execute(db),
    ).rejects.toThrow();

    const rerun = await migrator.migrateToLatest({ mode: "from-schema" });
    expect(rerun.operations).toEqual([]);
    await rerun.execute();
  } finally {
    await db.destroy();
  }
}, 120000);
