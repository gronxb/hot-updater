import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const rlsMigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260520014100_hot-updater_rls.sql",
);
const databaseMigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260713000000_hot-updater_0.38.0.sql",
);
const migrationsDir = path.dirname(rlsMigrationPath);

describe("Supabase RLS migration", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    for (const database of databases.splice(0)) {
      await database.close();
    }
  });

  it("runs the v0.38 migration after RLS hardening", async () => {
    const migrations = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    expect(migrations.at(-1)).toBe("20260713000000_hot-updater_0.38.0.sql");

    const sql = await fs.readFile(databaseMigrationPath, "utf8");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.get_channels");
    expect(sql).toContain("SET search_path = public, pg_catalog");
    expect(sql).not.toContain(
      "DROP FUNCTION IF EXISTS get_update_info_by_app_version",
    );
  });

  it("enables RLS on Hot Updater tables", async () => {
    const sql = await fs.readFile(rlsMigrationPath, "utf8");

    expect(sql).toContain(
      "ALTER TABLE public.bundles ENABLE ROW LEVEL SECURITY;",
    );
    expect(sql).toContain(
      "ALTER TABLE public.bundle_patches ENABLE ROW LEVEL SECURITY;",
    );
    expect(sql).not.toContain("REVOKE ALL ON TABLE");
    expect(sql).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE");
  });

  it("pins search_path for public Hot Updater functions", async () => {
    const sql = await fs.readFile(rlsMigrationPath, "utf8");
    const hotUpdaterFunctions = [
      "get_target_app_version_list",
      "get_channels",
      "positive_mod",
      "hash_rollout_value",
      "normalize_cohort_value",
      "gcd_int",
      "get_rollout_multiplier",
      "get_rollout_offset",
      "get_modular_inverse",
      "is_numeric_cohort",
      "get_numeric_cohort_rollout_position",
      "is_cohort_eligible",
      "get_update_info_by_fingerprint_hash",
      "get_update_info_by_app_version",
    ];

    for (const functionName of hotUpdaterFunctions) {
      expect(sql).toContain(`ALTER FUNCTION public.${functionName}`);
    }

    expect(sql.match(/SET search_path = public, pg_catalog;/g)).toHaveLength(
      hotUpdaterFunctions.length,
    );
  });

  it("does not change function execution grants", async () => {
    const sql = await fs.readFile(rlsMigrationPath, "utf8");

    expect(sql).not.toContain("REVOKE EXECUTE");
    expect(sql).not.toContain("GRANT EXECUTE");
  });

  it("backfills channels before adding a restrictive bundle relation", async () => {
    const sql = await fs.readFile(databaseMigrationPath, "utf8");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.bundle_channels");
    expect(sql).toContain("SELECT DISTINCT b.channel, b.channel");
    expect(sql).toContain("WHERE c.name = b.channel");
    expect(sql).toContain(
      "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",
    );
    expect(sql).toContain("name text NOT NULL UNIQUE");
    expect(sql).toContain("SET channel_id = c.id");
    expect(sql).toContain(
      "REFERENCES public.bundle_channels(id) ON DELETE RESTRICT",
    );
    expect(sql.indexOf("SELECT DISTINCT b.channel, b.channel")).toBeLessThan(
      sql.indexOf("REFERENCES public.bundle_channels(id) ON DELETE RESTRICT"),
    );
    expect(sql).not.toContain("DROP COLUMN channel");
    expect(sql).toContain(
      "JOIN public.bundle_channels c ON c.id = b.channel_id",
    );
    expect(sql).toContain("c.name = target_channel");
    expect(sql).toContain("SELECT c.name");
    expect(sql).toContain(
      "ALTER TABLE public.bundle_channels ENABLE ROW LEVEL SECURITY;",
    );
  });

  it("reuses an existing stable channel id for a legacy bundle name", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(`
      create table public.bundles (
        id uuid primary key,
        channel text not null
      );
      create table public.bundle_channels (
        id text primary key,
        name text not null unique
      );
      insert into public.bundles (id, channel)
      values ('00000000-0000-0000-0000-000000000001', 'production');
      insert into public.bundle_channels (id, name)
      values ('channel-production', 'production');
    `);

    await database.exec(`
      insert into public.bundle_channels (id, name)
      select distinct b.channel, b.channel
      from public.bundles b
      where not exists (
        select 1 from public.bundle_channels c where c.name = b.channel
      )
      on conflict (id) do update set name = excluded.name;
      alter table public.bundles add column channel_id text;
      update public.bundles b
      set channel_id = c.id
      from public.bundle_channels c
      where c.name = b.channel;
    `);

    const rows = await database.query<{
      channel: string;
      channel_id: string;
      name: string;
    }>(`
      select b.channel, b.channel_id, c.name
      from public.bundles b
      join public.bundle_channels c on c.id = b.channel_id
    `);
    expect(rows.rows).toEqual([
      {
        channel: "production",
        channel_id: "channel-production",
        name: "production",
      },
    ]);
  });

  it("keeps hardened ACLs while replacing channel-aware functions", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(`
      create type public.platforms as enum ('ios', 'android');
      create table public.bundles (
        id uuid primary key,
        platform public.platforms not null,
        enabled boolean not null,
        should_force_update boolean not null,
        message text,
        storage_uri text not null,
        file_hash text not null,
        rollout_cohort_count integer not null default 1000,
        target_cohorts text[],
        fingerprint_hash text,
        target_app_version text,
        channel text not null
      );
      insert into public.bundles (
        id, platform, enabled, should_force_update, storage_uri, file_hash,
        fingerprint_hash, channel
      ) values (
        '00000000-0000-0000-0000-000000000001', 'ios', true, false,
        's3://bundle', 'hash', 'fingerprint', 'production'
      );
      create role hot_updater_reader;
      create function public.get_channels()
      returns table(channel text)
      language sql
      set search_path = public, pg_catalog
      as 'select distinct b.channel from public.bundles b';
      create function public.is_cohort_eligible(uuid, text, integer, text[])
      returns boolean
      language sql
      immutable
      as 'select true';
      create function public.get_update_info_by_fingerprint_hash(
        public.platforms, uuid, uuid, text, text, text
      )
      returns table (
        id uuid, should_force_update boolean, message text, status text,
        storage_uri text, file_hash text
      )
      language sql
      set search_path = public, pg_catalog
      as 'select null::uuid, false, null::text, null::text, null::text, null::text where false';
      create function public.get_update_info_by_app_version(
        public.platforms, text, uuid, uuid, text, text[], text
      )
      returns table (
        id uuid, should_force_update boolean, message text, status text,
        storage_uri text, file_hash text
      )
      language sql
      set search_path = public, pg_catalog
      as 'select null::uuid, false, null::text, null::text, null::text, null::text where false';
      revoke all on function public.get_channels() from public;
      revoke all on function public.get_update_info_by_fingerprint_hash(
        public.platforms, uuid, uuid, text, text, text
      ) from public;
      revoke all on function public.get_update_info_by_app_version(
        public.platforms, text, uuid, uuid, text, text[], text
      ) from public;
      grant execute on function public.get_channels() to hot_updater_reader;
      grant execute on function public.get_update_info_by_fingerprint_hash(
        public.platforms, uuid, uuid, text, text, text
      ) to hot_updater_reader;
      grant execute on function public.get_update_info_by_app_version(
        public.platforms, text, uuid, uuid, text, text[], text
      ) to hot_updater_reader;
    `);

    await database.exec(await fs.readFile(databaseMigrationPath, "utf8"));

    const channels = await database.query<{ channel: string }>(
      "select channel from public.get_channels()",
    );
    expect(channels.rows).toEqual([{ channel: "production" }]);

    const functions = [
      "public.get_channels()",
      "public.get_update_info_by_fingerprint_hash(public.platforms,uuid,uuid,text,text,text)",
      "public.get_update_info_by_app_version(public.platforms,text,uuid,uuid,text,text[],text)",
    ];
    for (const functionName of functions) {
      const privileges = await database.query<{
        reader: boolean;
        everyone: boolean;
      }>(`
        select
          has_function_privilege('hot_updater_reader', '${functionName}', 'execute') as reader,
          has_function_privilege('public', '${functionName}', 'execute') as everyone
      `);
      expect(privileges.rows).toEqual([{ reader: true, everyone: false }]);
    }

    const configurations = await database.query<{ configuration: string[] }>(`
      select coalesce(proconfig, '{}') as configuration
      from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in (
          'get_channels',
          'get_update_info_by_fingerprint_hash',
          'get_update_info_by_app_version'
        )
    `);
    expect(configurations.rows).toHaveLength(3);
    for (const { configuration } of configurations.rows) {
      expect(configuration).toContain("search_path=public, pg_catalog");
    }
  });
});
