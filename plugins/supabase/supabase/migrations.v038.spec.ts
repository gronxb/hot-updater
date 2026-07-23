import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260713000000_hot-updater_0.38.0.sql",
);

describe("Supabase v0.38 bundle event migration", () => {
  let database: PGlite;
  let migration: string;

  beforeEach(async () => {
    database = new PGlite();
    migration = await fs.readFile(migrationPath, "utf8");
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
      create function public.is_cohort_eligible(uuid, text, integer, text[])
      returns boolean
      language sql
      immutable
      as 'select true';
    `);
  });

  afterEach(async () => {
    await database.close();
  });

  it("creates the final shape, indexes, checks, and RLS policy boundary", async () => {
    // When
    await database.exec(migration);
    await database.exec(`
      insert into bundle_events (
        id, type, install_id, from_bundle_id, to_bundle_id, platform,
        app_version, channel, cohort, update_strategy, received_at_ms
      ) values (
        '00000000-0000-0000-0000-000000000001', 'UPDATE_APPLIED',
        'install', '00000000-0000-0000-0000-000000000010',
        '00000000-0000-0000-0000-000000000011', 'ios', '1.0.0',
        'production', 'cohort', 'appVersion', 1
      );
      insert into bundle_events (
        id, type, install_id, from_bundle_id, to_bundle_id, platform,
        app_version, channel, cohort, update_strategy, received_at_ms
      ) values (
        '00000000-0000-0000-0000-000000000002', 'UNCHANGED',
        'install', null, '00000000-0000-0000-0000-000000000011',
        'ios', '1.0.0', 'production', 'cohort', null, 2
      );
    `);

    // Then
    const rows = await database.query<{ type: string }>(
      "select type from bundle_events order by received_at_ms",
    );
    expect(rows.rows).toEqual([
      { type: "UPDATE_APPLIED" },
      { type: "UNCHANGED" },
    ]);

    const indexes = await database.query<{ indexname: string }>(`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'bundle_events'
      order by indexname
    `);
    expect(indexes.rows).toHaveLength(8);

    const checks = await database.query<{ conname: string }>(`
      select conname from pg_constraint
      where conrelid = 'public.bundle_events'::regclass
        and contype = 'c'
      order by conname
    `);
    expect(checks.rows.map(({ conname }) => conname)).toEqual([
      "bundle_events_shape_v038_check",
      "bundle_events_type_v038_check",
      "bundle_events_update_strategy_v038_check",
    ]);

    const rls = await database.query<{ relrowsecurity: boolean }>(`
      select relrowsecurity from pg_class
      where oid = 'public.bundle_events'::regclass
    `);
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
  });

  it.each([
    ["UNKNOWN", "null", "null"],
    ["UNCHANGED", "'00000000-0000-0000-0000-000000000010'", "'fingerprint'"],
    ["UPDATE_APPLIED", "null", "null"],
    ["UPDATE_APPLIED", "'00000000-0000-0000-0000-000000000010'", "'invalid'"],
  ])(
    "rejects invalid %s event shapes",
    async (type, fromBundleId, strategy) => {
      // Given
      await database.exec(migration);

      // When / Then
      await expect(
        database.exec(`
        insert into bundle_events (
          id, type, install_id, from_bundle_id, to_bundle_id, platform,
          app_version, channel, cohort, update_strategy, received_at_ms
        ) values (
          '00000000-0000-0000-0000-000000000003', '${type}', 'install',
          ${fromBundleId}, '00000000-0000-0000-0000-000000000011',
          'ios', '1.0.0', 'production', 'cohort', ${strategy}, 1
        )
      `),
      ).rejects.toThrow();
    },
  );

  it("wraps the complete migration in one explicit transaction", () => {
    // When
    const statements = migration
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line === "BEGIN;" || line === "COMMIT;");

    // Then
    expect(statements).toEqual(["BEGIN;", "COMMIT;"]);
    expect(migration.trimStart()).toMatch(/^BEGIN;/);
    expect(migration.trimEnd()).toMatch(/COMMIT;$/);
  });

  it("rolls back bundle_events when late DDL fails", async () => {
    // Given
    const failingMigration = migration.replace(
      /\nCOMMIT;\s*$/,
      "\nCREATE TABLE bundle_events (id uuid);\n\nCOMMIT;",
    );
    expect(failingMigration).not.toBe(migration);

    // When
    await expect(database.exec(failingMigration)).rejects.toThrow(
      'relation "bundle_events" already exists',
    );
    await database.exec("ROLLBACK;");

    // Then
    const relations = await database.query<{ relation: string | null }>(
      "select to_regclass('public.bundle_events')::text as relation",
    );
    expect(relations.rows).toEqual([{ relation: null }]);
  });
});
