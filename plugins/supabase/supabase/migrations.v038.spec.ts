import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260713000000_hot-updater_0.38.0.sql",
);

describe("Supabase v0.38 bundle event migration", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    const migration = await fs.readFile(migrationPath, "utf8");
    const bundleEvents = migration.slice(
      migration.indexOf("-- HotUpdater.bundle_events"),
    );
    await database.exec(bundleEvents);
  });

  afterEach(async () => {
    await database.close();
  });

  it("creates the final shape, indexes, checks, and RLS policy boundary", async () => {
    // When
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

  it("fails repeated post-commit DDL with the conflicting relation", async () => {
    // Given
    const migration = await fs.readFile(migrationPath, "utf8");
    const bundleEvents = migration.slice(
      migration.indexOf("-- HotUpdater.bundle_events"),
    );

    // When / Then
    await expect(database.exec(bundleEvents)).rejects.toThrow(
      'relation "bundle_events" already exists',
    );
  });
});
