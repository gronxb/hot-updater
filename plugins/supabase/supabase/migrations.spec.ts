import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { materializeReleaseCatalogMigration } from "../iac/supabaseReleaseCatalogMigration";

const rlsMigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260520014100_hot-updater_rls.sql",
);
const officialDomainsMigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260811000000_hot-updater_0.37.0.sql",
);
const normalizedChannelsMigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260812000000_hot-updater_0.38.0.sql",
);

const readMigrations = async (through?: string) => {
  const migrationDirectory = path.resolve(
    "plugins/supabase/supabase/migrations",
  );
  const migrationFiles = (await fs.readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrations = await Promise.all(
    migrationFiles.map(async (file) => ({
      file,
      sql: await fs.readFile(path.join(migrationDirectory, file), "utf8"),
    })),
  );
  if (through === undefined) return migrations;
  const finalIndex = migrations.findIndex(({ file }) => file.includes(through));
  if (finalIndex < 0) throw new Error(`Migration ${through} was not found.`);
  return migrations.slice(0, finalIndex + 1);
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
    expect(sql).toContain('id text COLLATE "C" PRIMARY KEY NOT NULL');
    expect(sql).toContain('name text COLLATE "C" NOT NULL UNIQUE');
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS channel_id text");
    expect(sql).toContain("pg_catalog.char_length(id) BETWEEN 1 AND 255");
    expect(sql).toContain("pg_catalog.char_length(name) BETWEEN 1 AND 255");
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
      "CREATE FUNCTION public.hot_updater_delete_channel(p_id text)",
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
      for (const migration of await readMigrations("0.38.0")) {
        await database.exec(migration.sql);
      }

      const channelId = "tenant/acme:Production";
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
        "SELECT public.hot_updater_delete_channel($1::text) AS result",
        [channelId],
      );
      expect(directReferenced.rows[0]?.result).toEqual({
        deleted: false,
        reason: "not_empty",
      });

      const missing = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_delete_channel($1::text) AS result",
        ["missing/non-uuid-channel"],
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
        "SELECT public.hot_updater_delete_channel($1::text) AS result",
        [channelId],
      );
      expect(deleted.rows[0]?.result).toEqual({ deleted: true });
    } finally {
      await database.close();
    }
  });

  it("persists opaque Channel ids and case-sensitive names exactly", async () => {
    const database = new PGlite();
    try {
      await database.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
      );
      for (const migration of await readMigrations("0.38.0")) {
        await database.exec(migration.sql);
      }

      const channels = [
        { id: "channel:production/lower", name: "production" },
        { id: "channel:production/upper", name: "Production" },
      ];
      const commit = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_commit($1::jsonb) AS result",
        [
          JSON.stringify({
            changes: channels.map((row) => ({
              model: "channels",
              operation: "insert",
              row,
              onConflict: "ignore",
            })),
          }),
        ],
      );
      const stored = await database.query<{ id: string; name: string }>(
        'SELECT id, name FROM public.channels ORDER BY name COLLATE "C"',
      );

      expect(commit.rows[0]?.result).toEqual({ committed: true });
      expect(stored.rows).toEqual([channels[1], channels[0]]);
    } finally {
      await database.close();
    }
  });

  it.each(["id", "name"] as const)(
    "rejects a stored Channel %s longer than 255 Unicode code points",
    async (field) => {
      const database = new PGlite();
      try {
        await database.exec(
          "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
        );
        for (const migration of await readMigrations("0.38.0")) {
          await database.exec(migration.sql);
        }
        const row = {
          id: field === "id" ? "😀".repeat(256) : "valid-channel-id",
          name: field === "name" ? "😀".repeat(256) : "valid-channel-name",
        };

        await expect(
          database.query(
            "INSERT INTO public.channels (id, name) VALUES ($1, $2)",
            [row.id, row.name],
          ),
        ).rejects.toMatchObject({ code: "23514" });
      } finally {
        await database.close();
      }
    },
  );

  it("atomically maps every official model and conflict-ignored insert", async () => {
    const database = new PGlite();
    try {
      await database.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
      );
      for (const migration of await readMigrations("0.38.0")) {
        await database.exec(migration.sql);
      }

      const channelId = "opaque:production/channel";
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
      for (const migration of await readMigrations("0.38.0")) {
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

describe("Supabase Release Catalog migration", () => {
  const createDatabaseThroughV038 = async () => {
    const database = new PGlite();
    await database.exec(
      "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
    );
    for (const migration of await readMigrations("0.38.0")) {
      await database.exec(migration.sql);
    }
    return database;
  };

  it("preflights legacy policy into Releases and canonical catalogs before dropping it from Bundles", async () => {
    const database = await createDatabaseThroughV038();
    try {
      const bundleIds = [
        "00000000-0000-7000-8000-000000000041",
        "00000000-0000-7000-8000-000000000042",
      ];
      await database.exec(`
        INSERT INTO public.channels (id, name)
        VALUES ('channel-production', 'production');
        INSERT INTO public.bundles (
          id, platform, target_app_version, should_force_update, enabled,
          file_hash, channel, channel_id, storage_uri, metadata,
          rollout_cohort_count, target_cohorts
        ) VALUES (
          '${bundleIds[0]}', 'ios', '^1.0.0', false, true,
          'hash-1', 'production', 'channel-production', 'storage://bundle-1',
          '{}', 1000, ARRAY[]::text[]
        ), (
          '${bundleIds[1]}', 'ios', '^1.0.0', true, true,
          'hash-2', 'production', 'channel-production', 'storage://bundle-2',
          '{}', 500, ARRAY['qa']::text[]
        );
      `);
      const legacy = await database.query<{
        id: unknown;
        platform: unknown;
        channel: unknown;
        enabled: unknown;
        should_force_update: unknown;
        message: unknown;
        target_app_version: unknown;
        fingerprint_hash: unknown;
        rollout_cohort_count: unknown;
        target_cohorts: unknown;
      }>(`
        SELECT id, platform, channel, enabled, should_force_update, message,
          target_app_version, fingerprint_hash, rollout_cohort_count,
          target_cohorts
        FROM public.bundles
        ORDER BY id
      `);
      const migration = (await readMigrations()).find(({ file }) =>
        file.includes("1.0.0"),
      );
      if (!migration) throw new Error("v1 migration was not found");
      const sql = await materializeReleaseCatalogMigration({
        authorityId: "project-ref",
        legacyBundles: legacy.rows,
        migrationSql: migration.sql,
      });

      await database.exec(sql);

      const bundleColumns = await database.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bundles'
        ORDER BY ordinal_position
      `);
      expect(bundleColumns.rows.map(({ column_name }) => column_name)).toEqual([
        "id",
        "platform",
        "file_hash",
        "git_commit_hash",
        "metadata",
        "storage_uri",
        "manifest_storage_uri",
        "manifest_file_hash",
        "asset_base_storage_uri",
      ]);
      const releases = await database.query<{
        bundle_id: string;
        id: string;
        revision: number;
      }>("SELECT id, bundle_id, revision FROM public.releases ORDER BY id");
      expect(releases.rows).toEqual(
        bundleIds.map((id) => ({ bundle_id: id, id, revision: 1 })),
      );
      const catalogs = await database.query<{
        authority_id: string;
        catalog_hash: string;
        generation: number;
        payload: string;
      }>(
        "SELECT authority_id, catalog_hash, generation, payload FROM public.release_catalogs",
      );
      expect(catalogs.rows).toHaveLength(1);
      expect(catalogs.rows[0]).toMatchObject({
        authority_id: "project-ref",
        generation: 1,
      });
      expect(catalogs.rows[0]?.catalog_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.parse(catalogs.rows[0]?.payload ?? "")).toMatchObject({
        schemaVersion: 1,
        strategy: "APP_VERSION",
      });
    } finally {
      await database.close();
    }
  });

  it("blocks a manual legacy cutover that did not run the deterministic preflight", async () => {
    const database = await createDatabaseThroughV038();
    try {
      await database.exec(`
        INSERT INTO public.channels (id, name) VALUES ('channel', 'production');
        INSERT INTO public.bundles (
          id, platform, target_app_version, should_force_update, enabled,
          file_hash, channel, channel_id, storage_uri, metadata,
          rollout_cohort_count
        ) VALUES (
          '00000000-0000-7000-8000-000000000051', 'ios', '1.0.0', false,
          true, 'hash', 'production', 'channel', 'storage://bundle', '{}', 1000
        );
      `);
      const migration = (await readMigrations()).find(({ file }) =>
        file.includes("1.0.0"),
      );

      await expect(database.exec(migration?.sql ?? "")).rejects.toThrow(
        "requires Hot Updater init",
      );
      const columns = await database.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bundles'
      `);
      expect(columns.rows.map(({ column_name }) => column_name)).toContain(
        "target_app_version",
      );
    } finally {
      await database.close();
    }
  });

  it("enforces Release/catalog CAS and rolls back referenced artifact deletion", async () => {
    const database = await createDatabaseThroughV038();
    try {
      const migration = (await readMigrations()).find(({ file }) =>
        file.includes("1.0.0"),
      );
      await database.exec(
        await materializeReleaseCatalogMigration({
          authorityId: "project-ref",
          legacyBundles: [],
          migrationSql: migration?.sql ?? "",
        }),
      );
      const bundleId = "00000000-0000-7000-8000-000000000061";
      const releaseId = "00000000-0000-7000-8000-000000000062";
      const scopeKey = "v1:app-version:project-ref:ios:cHJvZHVjdGlvbg";
      const initial = {
        changes: [
          {
            model: "channels",
            operation: "insert",
            row: { id: "channel-production", name: "production" },
            onConflict: "ignore",
          },
          {
            model: "bundles",
            operation: "insert",
            row: {
              id: bundleId,
              platform: "ios",
              file_hash: "hash",
              git_commit_hash: null,
              storage_uri: "storage://bundle",
              metadata: {},
              manifest_storage_uri: null,
              manifest_file_hash: null,
              asset_base_storage_uri: null,
            },
          },
          {
            model: "releases",
            operation: "insert",
            row: {
              id: releaseId,
              revision: 1,
              scope_key: scopeKey,
              channel_id: "channel-production",
              platform: "ios",
              kind: "BUNDLE",
              bundle_id: bundleId,
              strategy: "APP_VERSION",
              target_app_version: "1.0.0",
              fingerprint_hash: null,
              enabled: true,
              should_force_update: false,
              message: null,
              rollout_cohort_count: 1000,
              target_cohorts: [],
              operation: "DEPLOY",
              source_release_id: null,
              created_at_ms: 1,
              updated_at_ms: 1,
            },
          },
          {
            model: "releaseCatalogs",
            operation: "put",
            row: {
              scope_key: scopeKey,
              authority_id: "project-ref",
              strategy: "APP_VERSION",
              channel_id: "channel-production",
              channel_key: "cHJvZHVjdGlvbg",
              platform: "ios",
              fingerprint_hash: null,
              generation: 1,
              payload: "{}",
              catalog_hash:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
              byte_size: 2,
              is_tombstone: false,
              updated_at_ms: 1,
            },
          },
        ],
        expectations: [
          { model: "releases", id: releaseId, revision: null },
          { model: "releaseCatalogs", scopeKey, generation: null },
        ],
      };
      const created = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_commit($1::jsonb) AS result",
        [JSON.stringify(initial)],
      );
      expect(created.rows[0]?.result).toEqual({ committed: true });

      const stale = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_commit($1::jsonb) AS result",
        [
          JSON.stringify({
            changes: [
              {
                model: "bundles",
                operation: "delete",
                where: { id: bundleId },
              },
            ],
            expectations: [
              { model: "releases", id: releaseId, revision: null },
            ],
          }),
        ],
      );
      expect(stale.rows[0]?.result).toEqual({
        committed: false,
        conflict: {
          actualVersion: 1,
          changeIndex: -1,
          expectedVersion: null,
          key: releaseId,
          model: "releases",
          reason: "version_conflict",
        },
      });

      const referenced = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_commit($1::jsonb) AS result",
        [
          JSON.stringify({
            changes: [
              {
                model: "bundles",
                operation: "delete",
                where: { id: bundleId },
              },
            ],
          }),
        ],
      );
      expect(referenced.rows[0]?.result).toEqual({
        committed: false,
        conflict: { changeIndex: 0, reason: "referenced" },
      });
      const rows = await database.query<{ id: string }>(
        "SELECT id FROM public.bundles WHERE id = $1",
        [bundleId],
      );
      expect(rows.rows).toEqual([{ id: bundleId }]);
    } finally {
      await database.close();
    }
  });
});
