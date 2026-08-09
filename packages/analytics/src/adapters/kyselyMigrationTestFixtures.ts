import { sql, type Kysely } from "kysely";

import {
  createKyselyTestDatabase,
  type KyselyTestDatabase,
} from "./kyselyTestDatabase";

const databases: KyselyTestDatabase[] = [];

export const createMigrationTestDatabase = async (
  settings: readonly (readonly [string, string])[] = [],
): Promise<Kysely<object>> => {
  const testDatabase = createKyselyTestDatabase();
  const database = testDatabase.database;
  databases.push(testDatabase);
  await sql
    .raw(`
    create table private_hot_updater_settings (
      key text primary key,
      value text not null
    )
  `)
    .execute(database);
  for (const [key, value] of settings) {
    await sql`insert into ${sql.table(
      "private_hot_updater_settings",
    )} (${sql.ref("key")}, ${sql.ref("value")}) values (${key}, ${value})`.execute(
      database,
    );
  }
  return database;
};

export const executeMigrationTestStatements = async (
  database: Kysely<object>,
  statements: readonly string[],
): Promise<void> => {
  for (const statement of statements)
    await sql.raw(statement).execute(database);
};

export const createV1MigrationTestSchema = async (
  database: Kysely<object>,
): Promise<void> => {
  await executeMigrationTestStatements(database, [
    `create table bundle_events (
      id uuid primary key not null,
      type text not null,
      install_id text not null,
      user_id text,
      username text,
      from_bundle_id uuid not null,
      to_bundle_id uuid not null,
      platform text not null,
      app_version text not null,
      channel text not null,
      cohort text not null,
      update_strategy text not null,
      fingerprint_hash text,
      sdk_version text,
      received_at_ms double precision not null,
      constraint bundle_events_type_check
        check (type in ('UPDATE_APPLIED', 'RECOVERED')),
      constraint bundle_events_update_strategy_check
        check (update_strategy in ('fingerprint', 'appVersion'))
    )`,
    "create index bundle_events_installed_bundle_idx on bundle_events(type, to_bundle_id, received_at_ms, id)",
    "create index bundle_events_recovered_bundle_idx on bundle_events(type, from_bundle_id, received_at_ms, id)",
    "create index bundle_events_install_idx on bundle_events(install_id, received_at_ms, id)",
    "create index bundle_events_user_id_idx on bundle_events(user_id, received_at_ms, id)",
    "create index bundle_events_username_idx on bundle_events(username, received_at_ms, id)",
    "create index bundle_events_cohort_idx on bundle_events(cohort, type, received_at_ms, id)",
    "create index bundle_events_received_at_idx on bundle_events(received_at_ms, id)",
  ]);
};

export const storedAnalyticsMarker = async (
  database: Kysely<object>,
): Promise<string | null> => {
  const result = await sql<{ readonly value: string }>`
    select ${sql.ref("value")} from ${sql.table(
      "private_hot_updater_settings",
    )} where ${sql.ref("key")} = ${"schema.analytics"}
  `.execute(database);
  return result.rows[0]?.value ?? null;
};

export const destroyMigrationTestDatabases = async (): Promise<void> => {
  for (const database of databases.splice(0)) await database.destroy();
};
