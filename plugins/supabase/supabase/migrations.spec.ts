import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const rlsMigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260520014100_hot-updater_rls.sql",
);
const officialDomainsMigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260811000000_hot-updater_0.37.0.sql",
);
const normalizedChannelsMigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260812000000_hot-updater_0.38.0.sql",
);

const readMigrations = async () => {
  const migrationDirectory = path.resolve(
    "plugins/supabase/supabase/migrations",
  );
  const migrationFiles = (await fs.readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  return Promise.all(
    migrationFiles.map(async (file) => ({
      file,
      sql: await fs.readFile(path.join(migrationDirectory, file), "utf8"),
    })),
  );
};
describe("Supabase RLS migration", () => {
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
});

describe("Supabase official database domains migration", () => {
  it("creates protected analytics and client access-key tables", async () => {
    const sql = await fs.readFile(officialDomainsMigrationPath, "utf8");

    expect(sql).toContain("CREATE TABLE public.bundle_events");
    expect(sql).toContain("CREATE TABLE public.client_access_keys");
    expect(sql).toContain(
      "ALTER TABLE public.bundle_events ENABLE ROW LEVEL SECURITY;",
    );
    expect(sql).toContain(
      "ALTER TABLE public.client_access_keys ENABLE ROW LEVEL SECURITY;",
    );
  });

  it("installs the legacy commit before the append-only 0.38 replacement", async () => {
    const sql = await fs.readFile(officialDomainsMigrationPath, "utf8");

    expect(sql).toContain(
      "CREATE FUNCTION public.hot_updater_commit(p_mutations jsonb)",
    );
    expect(sql).toContain("FOR UPDATE;");
    expect(sql).toContain("'missingBundleId'");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION");
    expect(sql).toContain("FROM PUBLIC, anon, authenticated;");
    expect(sql).toContain("TO service_role;");
    expect(sql).not.toContain("pg_catalog.coalesce");
  });
});

describe("Supabase normalized Channel migration", () => {
  it("backfills canonical channels before enforcing the bundle foreign key", async () => {
    const database = new PGlite();
    try {
      await database.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
      );
      const migrations = await readMigrations();
      for (const migration of migrations) {
        if (migration.file.includes("0.38.0")) break;
        await database.exec(migration.sql);
      }

      await database.exec(`
        INSERT INTO public.bundles (
          id, platform, target_app_version, should_force_update, enabled,
          file_hash, channel, storage_uri, metadata, rollout_cohort_count
        ) VALUES (
          '00000000-0000-0000-0000-000000000001', 'ios', '1.0.0', false, true,
          'hash', 'production', 'storage://bundle', '{}', 1000
        ), (
          '00000000-0000-0000-0000-000000000002', 'android', '1.0.0', false, true,
          'hash-2', 'production', 'storage://bundle-2', '{}', 1000
        ), (
          '00000000-0000-0000-0000-000000000003', 'ios', '1.0.0', false, true,
          'hash-3', 'staging', 'storage://bundle-3', '{}', 1000
        );
      `);
      await database.exec(
        await fs.readFile(normalizedChannelsMigrationPath, "utf8"),
      );
      const channels = await database.query<{ id: string; name: string }>(
        "SELECT id, name FROM public.channels ORDER BY name",
      );
      const bundles = await database.query<{
        channel: string;
        channel_id: string;
      }>("SELECT channel, channel_id FROM public.bundles ORDER BY id");

      expect(channels.rows.map(({ name }) => name)).toEqual([
        "production",
        "staging",
      ]);
      expect(bundles.rows[0]?.channel_id).toBe(bundles.rows[1]?.channel_id);
      for (const bundle of bundles.rows) {
        expect(channels.rows).toContainEqual({
          id: bundle.channel_id,
          name: bundle.channel,
        });
      }
    } finally {
      await database.close();
    }
  });

  it("replaces bundle-specific RPCs with one service-role generic commit", async () => {
    const sql = await fs.readFile(normalizedChannelsMigrationPath, "utf8");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.channels");
    expect(sql).toContain("ALTER COLUMN channel_id SET NOT NULL");
    expect(sql).toContain("FOREIGN KEY (channel_id)");
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.get_channels()");
    expect(sql).toContain(
      "DROP FUNCTION IF EXISTS public.hot_updater_create_bundle_with_patches",
    );
    expect(sql).toContain(
      "DROP FUNCTION IF EXISTS public.hot_updater_update_bundle_with_patches",
    );
    expect(sql).toContain(
      "CREATE FUNCTION public.hot_updater_commit(p_commit jsonb)",
    );
    expect(sql).toContain(
      "CREATE FUNCTION public.hot_updater_delete_channel(p_id uuid)",
    );
    expect(sql).toContain("v_change->>'model'");
    expect(sql).toContain("'changeIndex', v_change_index");
    expect(sql).toContain("'committed', true");
    expect(sql).not.toContain("missingBundleId");
  });

  it("reports direct Channel deletion outcomes and rolls back referenced commit deletes", async () => {
    const database = new PGlite();
    try {
      await database.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
      );
      for (const migration of await readMigrations()) {
        await database.exec(migration.sql);
      }

      const channelId = "00000000-0000-0000-0000-000000000030";
      const bundleId = "00000000-0000-0000-0000-000000000031";
      await database.exec(`
        INSERT INTO public.channels (id, name)
        VALUES ('${channelId}', 'production');
        INSERT INTO public.bundles (
          id, platform, target_app_version, should_force_update, enabled,
          file_hash, channel, channel_id, storage_uri, metadata,
          rollout_cohort_count
        ) VALUES (
          '${bundleId}', 'ios', '1.0.0', false, true,
          'hash', 'production', '${channelId}', 'storage://bundle', '{}', 1000
        );
      `);

      const directReferenced = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_delete_channel($1::uuid) AS result",
        [channelId],
      );
      expect(directReferenced.rows[0]?.result).toEqual({
        deleted: false,
        reason: "not_empty",
      });

      const missing = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_delete_channel($1::uuid) AS result",
        ["00000000-0000-0000-0000-000000000039"],
      );
      expect(missing.rows[0]?.result).toEqual({
        deleted: false,
        reason: "not_found",
      });

      const commit = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_commit($1::jsonb) AS result",
        [
          JSON.stringify({
            changes: [
              {
                model: "bundles",
                operation: "update",
                where: { id: bundleId },
                update: { message: "must-roll-back" },
              },
              {
                model: "channels",
                operation: "delete",
                where: { id: channelId },
              },
            ],
          }),
        ],
      );
      const bundle = await database.query<{ message: string | null }>(
        "SELECT message FROM public.bundles WHERE id = $1",
        [bundleId],
      );
      expect(commit.rows[0]?.result).toEqual({
        committed: false,
        conflict: { changeIndex: 1, reason: "referenced" },
      });
      expect(bundle.rows).toEqual([{ message: null }]);

      await database.exec(
        `DELETE FROM public.bundles WHERE id = '${bundleId}'`,
      );
      const deleted = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_delete_channel($1::uuid) AS result",
        [channelId],
      );
      expect(deleted.rows[0]?.result).toEqual({ deleted: true });
    } finally {
      await database.close();
    }
  });

  it("atomically maps every official model and conflict-ignored insert", async () => {
    const database = new PGlite();
    try {
      await database.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
      );
      for (const migration of await readMigrations()) {
        await database.exec(migration.sql);
      }

      const channelId = "00000000-0000-0000-0000-000000000020";
      const baseBundleId = "00000000-0000-0000-0000-000000000021";
      const ownerBundleId = "00000000-0000-0000-0000-000000000022";
      const bundleRow = (id: string) => ({
        id,
        platform: "ios",
        target_app_version: "1.0.0",
        should_force_update: false,
        enabled: true,
        file_hash: `hash-${id}`,
        git_commit_hash: null,
        message: null,
        channel: "production",
        channel_id: channelId,
        fingerprint_hash: null,
        metadata: {},
        storage_uri: `storage://${id}`,
        rollout_cohort_count: 1000,
        target_cohorts: null,
        manifest_storage_uri: null,
        manifest_file_hash: null,
        asset_base_storage_uri: null,
      });
      const result = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_commit($1::jsonb) AS result",
        [
          JSON.stringify({
            changes: [
              {
                model: "channels",
                operation: "insert",
                row: { id: channelId, name: "production" },
                onConflict: "ignore",
              },
              {
                model: "bundles",
                operation: "insert",
                row: bundleRow(baseBundleId),
              },
              {
                model: "bundles",
                operation: "insert",
                row: bundleRow(ownerBundleId),
              },
              {
                model: "bundlePatches",
                operation: "insert",
                row: {
                  id: `${ownerBundleId}:${baseBundleId}`,
                  bundle_id: ownerBundleId,
                  base_bundle_id: baseBundleId,
                  base_file_hash: "hash-base",
                  patch_file_hash: "hash-patch",
                  patch_storage_uri: "storage://patch",
                  order_index: 0,
                },
              },
              {
                model: "analytics",
                operation: "insert",
                row: {
                  id: "00000000-0000-0000-0000-000000000023",
                  type: "UPDATE_APPLIED",
                  install_id: "install-1",
                  user_id: null,
                  username: null,
                  from_bundle_id: baseBundleId,
                  to_bundle_id: ownerBundleId,
                  platform: "ios",
                  app_version: "1.0.0",
                  channel: "production",
                  cohort: "0",
                  update_strategy: "appVersion",
                  fingerprint_hash: null,
                  sdk_version: null,
                  received_at_ms: 1,
                },
              },
              {
                model: "clientAccessKeys",
                operation: "insert",
                row: {
                  id: "key-1",
                  hash: "hash-key-1",
                  name: "test key",
                  prefix: "hu_test",
                  role: "client",
                  created_at_ms: 1,
                  revoked_at_ms: null,
                },
                onConflict: "ignore",
              },
            ],
          }),
        ],
      );

      expect(result.rows[0]?.result).toEqual({ committed: true });
      const counts = await database.query<{
        bundles: number;
        channels: number;
        events: number;
        keys: number;
        patches: number;
      }>(`
        SELECT
          (SELECT count(*)::integer FROM public.bundles) AS bundles,
          (SELECT count(*)::integer FROM public.bundle_patches) AS patches,
          (SELECT count(*)::integer FROM public.channels) AS channels,
          (SELECT count(*)::integer FROM public.bundle_events) AS events,
          (SELECT count(*)::integer FROM public.client_access_keys) AS keys
      `);
      expect(counts.rows).toEqual([
        { bundles: 2, channels: 1, events: 1, keys: 1, patches: 1 },
      ]);

      const ignored = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_commit($1::jsonb) AS result",
        [
          JSON.stringify({
            changes: [
              {
                model: "channels",
                operation: "insert",
                row: {
                  id: "00000000-0000-0000-0000-000000000024",
                  name: "production",
                },
                onConflict: "ignore",
              },
              {
                model: "clientAccessKeys",
                operation: "insert",
                row: {
                  id: "key-2",
                  hash: "hash-key-1",
                  name: "ignored key",
                  prefix: "hu_ignored",
                  role: "client",
                  created_at_ms: 2,
                  revoked_at_ms: null,
                },
                onConflict: "ignore",
              },
            ],
          }),
        ],
      );
      expect(ignored.rows[0]?.result).toEqual({ committed: true });
      const idempotentCounts = await database.query<{
        channels: number;
        keys: number;
      }>(`
        SELECT
          (SELECT count(*)::integer FROM public.channels) AS channels,
          (SELECT count(*)::integer FROM public.client_access_keys) AS keys
      `);
      expect(idempotentCounts.rows).toEqual([{ channels: 1, keys: 1 }]);
    } finally {
      await database.close();
    }
  });

  it("rolls back earlier generic changes when a later update target is missing", async () => {
    const database = new PGlite();
    try {
      await database.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
      );
      for (const migration of await readMigrations()) {
        await database.exec(migration.sql);
      }

      const channelId = "00000000-0000-0000-0000-000000000010";
      const existingId = "00000000-0000-0000-0000-000000000011";
      const missingId = "00000000-0000-0000-0000-000000000012";
      await database.exec(`
        INSERT INTO public.channels (id, name)
        VALUES ('${channelId}', 'production');
        INSERT INTO public.bundles (
          id, platform, target_app_version, should_force_update, enabled,
          file_hash, channel, channel_id, storage_uri, metadata,
          rollout_cohort_count
        ) VALUES (
          '${existingId}', 'ios', '1.0.0', false, true,
          'hash', 'production', '${channelId}', 'storage://bundle', '{}', 1000
        );
      `);

      const commit = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_commit($1::jsonb) AS result",
        [
          JSON.stringify({
            changes: [
              {
                model: "bundles",
                operation: "update",
                where: { id: existingId },
                update: { message: "must-roll-back" },
              },
              {
                model: "bundles",
                operation: "update",
                where: { id: missingId },
                update: { message: "missing" },
              },
            ],
          }),
        ],
      );
      const row = await database.query<{ message: string | null }>(
        "SELECT message FROM public.bundles WHERE id = $1",
        [existingId],
      );

      expect(commit.rows[0]?.result).toEqual({
        committed: false,
        conflict: { changeIndex: 1, reason: "not_found" },
      });
      expect(row.rows).toEqual([{ message: null }]);

      await database.exec(`
        INSERT INTO public.bundles (
          id, platform, target_app_version, should_force_update, enabled,
          file_hash, channel, channel_id, storage_uri, metadata,
          rollout_cohort_count
        ) VALUES (
          '${missingId}', 'android', '1.0.0', false, true,
          'hash-2', 'production', '${channelId}', 'storage://bundle-2', '{}', 1000
        );
      `);
      const successfulCommit = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_commit($1::jsonb) AS result",
        [
          JSON.stringify({
            changes: [
              {
                model: "bundles",
                operation: "update",
                where: { id: existingId },
                update: { message: "must-roll-back" },
              },
              {
                model: "bundles",
                operation: "update",
                where: { id: missingId },
                update: { message: "missing" },
              },
            ],
          }),
        ],
      );
      const updatedRows = await database.query<{
        id: string;
        message: string | null;
      }>("SELECT id, message FROM public.bundles ORDER BY id");

      expect(successfulCommit.rows[0]?.result).toEqual({ committed: true });
      expect(updatedRows.rows).toEqual([
        { id: existingId, message: "must-roll-back" },
        { id: missingId, message: "missing" },
      ]);
    } finally {
      await database.close();
    }
  });
});
