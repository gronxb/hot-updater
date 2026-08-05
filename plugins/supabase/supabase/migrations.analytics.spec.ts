import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260805000000_hot-updater_analytics_2.sql",
);
const databases: PGlite[] = [];

const createDatabase = (): PGlite => {
  const database = new PGlite();
  databases.push(database);
  return database;
};

const migrate = async (database: PGlite): Promise<void> => {
  await database.exec(await fs.readFile(migrationPath, "utf8"));
};

const initializeSettings = async (database: PGlite): Promise<void> => {
  await database.exec(`
    create table private_hot_updater_settings (
      key text primary key not null,
      value text not null
    );
    insert into private_hot_updater_settings (key, value)
    values ('version', '0.36.0');
  `);
};

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
});

describe("Supabase Analytics migration artifact", () => {
  it("installs a private schema 2 table after the existing Supabase history", async () => {
    const database = createDatabase();
    await initializeSettings(database);

    await migrate(database);

    const marker = await database.query<{ readonly value: string }>(
      "select value from private_hot_updater_settings where key = 'schema.analytics'",
    );
    expect(marker.rows).toEqual([{ value: "2" }]);
    const table = await database.query<{
      readonly relrowsecurity: boolean;
    }>(
      "select relrowsecurity from pg_class where oid = 'bundle_events'::regclass",
    );
    expect(table.rows).toEqual([{ relrowsecurity: true }]);
  });

  it("preserves RLS and policies while adopting an exact unmarked schema 2 table", async () => {
    const database = createDatabase();
    await initializeSettings(database);
    await migrate(database);
    await database.exec(`
      create policy existing_analytics_policy on bundle_events
        for select using (true);
      delete from private_hot_updater_settings where key = 'schema.analytics';
    `);

    await migrate(database);

    const adoption = await database.query<{
      readonly policyname: string;
      readonly relrowsecurity: boolean;
      readonly value: string;
    }>(`
      select policy.policyname, relation.relrowsecurity, settings.value
      from pg_policies as policy
      join pg_class as relation on relation.relname = policy.tablename
      join private_hot_updater_settings as settings
        on settings.key = 'schema.analytics'
      where policy.tablename = 'bundle_events'
    `);
    expect(adoption.rows).toEqual([
      {
        policyname: "existing_analytics_policy",
        relrowsecurity: true,
        value: "2",
      },
    ]);
  });

  it("rejects adoption when an exact unmarked schema 2 table has RLS disabled", async () => {
    const database = createDatabase();
    await initializeSettings(database);
    await migrate(database);
    await database.exec(`
      delete from private_hot_updater_settings where key = 'schema.analytics';
      alter table bundle_events disable row level security;
    `);

    await expect(migrate(database)).rejects.toThrow(
      "Supabase Analytics adoption requires row level security",
    );
    await database.exec("rollback");

    const marker = await database.query<{ readonly value: string }>(
      "select value from private_hot_updater_settings where key = 'schema.analytics'",
    );
    expect(marker.rows).toEqual([]);
  });

  it("rejects an integer timestamp lookalike instead of adopting it as schema 2", async () => {
    const database = createDatabase();
    await initializeSettings(database);
    await migrate(database);
    await database.exec(`
      delete from private_hot_updater_settings where key = 'schema.analytics';
      alter table bundle_events
        alter column received_at_ms type integer
        using received_at_ms::integer;
    `);

    await expect(migrate(database)).rejects.toThrow(
      "Analytics schema has unsupported physical drift",
    );
    await database.exec("rollback");

    const marker = await database.query<{ readonly value: string }>(
      "select value from private_hot_updater_settings where key = 'schema.analytics'",
    );
    expect(marker.rows).toEqual([]);
  });

  it("rejects a legacy version outside the Core compatibility contract", async () => {
    const database = createDatabase();
    await database.exec(`
      create table private_hot_updater_settings (
        key text primary key not null,
        value text not null
      );
      insert into private_hot_updater_settings (key, value)
      values ('version', '0.30.0');
    `);

    await expect(migrate(database)).rejects.toThrow(
      "Unknown legacy Hot Updater schema version: 0.30.0",
    );
    await database.exec("rollback");

    const table = await database.query<{ readonly name: string | null }>(
      "select to_regclass('public.bundle_events')::text as name",
    );
    expect(table.rows).toEqual([{ name: null }]);
  });
});
