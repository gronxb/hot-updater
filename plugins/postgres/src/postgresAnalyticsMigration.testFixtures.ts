import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { expect } from "vitest";

const migrationPath = path.resolve("plugins/postgres/sql/analytics.sql");
const databases: PGlite[] = [];

const indexes = `
  create index bundle_events_installed_bundle_idx
    on bundle_events(type, to_bundle_id, received_at_ms, id);
  create index bundle_events_recovered_bundle_idx
    on bundle_events(type, from_bundle_id, received_at_ms, id);
  create index bundle_events_install_idx
    on bundle_events(install_id, received_at_ms, id);
  create index bundle_events_user_id_idx
    on bundle_events(user_id, received_at_ms, id);
  create index bundle_events_username_idx
    on bundle_events(username, received_at_ms, id);
  create index bundle_events_cohort_idx
    on bundle_events(cohort, type, received_at_ms, id);
  create index bundle_events_received_at_idx
    on bundle_events(received_at_ms, id);
`;

const columns = `
  id uuid primary key not null,
  type text not null,
  install_id text not null,
  user_id text,
  username text,
  from_bundle_id uuid,
  to_bundle_id uuid not null,
  platform text not null,
  app_version text not null,
  channel text not null,
  cohort text not null,
  update_strategy text,
  fingerprint_hash text,
  sdk_version text,
  received_at_ms double precision not null
`;

export function createDatabase(): PGlite {
  const database = new PGlite();
  databases.push(database);
  return database;
}

export async function closeDatabases(): Promise<void> {
  for (const database of databases.splice(0)) {
    await database.close();
  }
}

export async function migrate(database: PGlite): Promise<void> {
  await database.exec(await fs.readFile(migrationPath, "utf8"));
}

export async function initializeSettings(
  database: PGlite,
  legacyVersion: string,
  markerConstraint = "",
): Promise<void> {
  await database.exec(`
    create table private_hot_updater_settings (
      key text primary key not null,
      value text not null
      ${markerConstraint}
    );
    insert into private_hot_updater_settings (key, value) values
      ('version', '${legacyVersion}'),
      ('sentinel', 'keep');
  `);
}

export async function initializeV1(database: PGlite): Promise<void> {
  await database.exec(`
    create table bundle_events (
      ${columns
        .replace("from_bundle_id uuid,", "from_bundle_id uuid not null,")
        .replace("update_strategy text,", "update_strategy text not null,")},
      constraint bundle_events_type_check
        check (type in ('UPDATE_APPLIED', 'RECOVERED')),
      constraint bundle_events_update_strategy_check
        check (update_strategy in ('fingerprint', 'appVersion'))
    );
    ${indexes}
    alter table bundle_events enable row level security;
    create policy existing_analytics_policy on bundle_events
      for select using (true);
    insert into bundle_events (
      id, type, install_id, from_bundle_id, to_bundle_id, platform,
      app_version, channel, cohort, update_strategy, received_at_ms
    ) values (
      '00000000-0000-0000-0000-000000000101', 'UPDATE_APPLIED',
      'install-1', '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002', 'ios', '1.0.0',
      'production', 'default', 'appVersion', 1000
    );
  `);
}

export async function initializeV2(
  database: PGlite,
  receivedAtType = "double precision",
): Promise<void> {
  await database.exec(`
    create table bundle_events (
      ${columns.replace("double precision", receivedAtType)},
      constraint bundle_events_type_v038_check
        check (type in ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')),
      constraint bundle_events_update_strategy_v038_check
        check (update_strategy is null or
          update_strategy in ('fingerprint', 'appVersion')),
      constraint bundle_events_shape_v038_check check (
        (type in ('UPDATE_APPLIED', 'RECOVERED') and
          from_bundle_id is not null and update_strategy is not null) or
        (type = 'UNCHANGED' and from_bundle_id is null and
          update_strategy is null)
      )
    );
    ${indexes}
  `);
}

export async function readSettings(
  database: PGlite,
): Promise<readonly { readonly key: string; readonly value: string }[]> {
  return (
    await database.query<{ readonly key: string; readonly value: string }>(
      "select key, value from private_hot_updater_settings order by key",
    )
  ).rows;
}

export async function expectMigrationFailure(database: PGlite): Promise<void> {
  await expect(migrate(database)).rejects.toThrow();
  await database.exec("rollback");
}
