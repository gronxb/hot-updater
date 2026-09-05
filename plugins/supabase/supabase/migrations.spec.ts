import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { toInsightsInstallationRow } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import { createBundleEventRowFixture } from "../../../packages/test-utils/src/databaseTestFixtures";

const migrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260818000000_hot-updater_1.0.0.sql",
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

describe("Supabase v1 schema", () => {
  it("preserves reports on upgrade and atomically records retries through the service-role RPC", async () => {
    const database = new PGlite();
    const event = createBundleEventRowFixture("9301", 100);
    const installation = toInsightsInstallationRow(event);
    try {
      await database.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
      );
      const [initial, upgrade] = await readMigrations();
      await database.exec(initial!.sql);
      await database.query(
        `INSERT INTO public.hot_updater_v1_bundle_events
        SELECT * FROM jsonb_populate_record(NULL::public.hot_updater_v1_bundle_events, $1::jsonb)`,
        [JSON.stringify(event)],
      );
      await database.query(
        `INSERT INTO public.hot_updater_v1_bundle_installations
        SELECT * FROM jsonb_populate_record(NULL::public.hot_updater_v1_bundle_installations, $1::jsonb)`,
        [JSON.stringify(installation)],
      );
      await database.exec(upgrade!.sql);
      expect(
        (
          await database.query(
            "SELECT id FROM public.hot_updater_v1_bundle_events",
          )
        ).rows,
      ).toEqual([{ id: event.id }]);
      const record = (row: typeof event) =>
        database.query(
          "SELECT public.hot_updater_v1_record_insights($1::jsonb, $2::jsonb)",
          [JSON.stringify(row), JSON.stringify(toInsightsInstallationRow(row))],
        );
      const reusedId = {
        ...event,
        user_id: "duplicate-user",
        received_at_ms: 200,
      };
      await record(reusedId);
      expect(
        (
          await database.query(
            "SELECT * FROM public.hot_updater_v1_bundle_installations",
          )
        ).rows,
      ).toEqual([installation]);
      const next = {
        ...event,
        id: createBundleEventRowFixture("9302", 200).id,
        received_at_ms: 200,
      };
      await database.exec(`
        CREATE FUNCTION fail_insights_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected snapshot failure'; END; $$;
        CREATE TRIGGER fail_insights_snapshot BEFORE INSERT ON public.hot_updater_v1_bundle_installations
        FOR EACH ROW EXECUTE FUNCTION fail_insights_snapshot();
      `);
      await expect(record(next)).rejects.toThrow("injected snapshot failure");
      expect(
        (
          await database.query(
            "SELECT id FROM public.hot_updater_v1_bundle_events",
          )
        ).rows,
      ).toEqual([{ id: event.id }]);
      expect(
        (
          await database.query(
            "SELECT * FROM public.hot_updater_v1_bundle_installations",
          )
        ).rows,
      ).toEqual([installation]);
      await database.exec(
        "DROP TRIGGER fail_insights_snapshot ON public.hot_updater_v1_bundle_installations",
      );
      await record(next);
      await record(next);
      expect(
        (
          await database.query(
            "SELECT * FROM public.hot_updater_v1_bundle_installations",
          )
        ).rows,
      ).toEqual([toInsightsInstallationRow(next)]);
      expect(
        (
          await database.query(
            "SELECT COUNT(*)::integer AS count FROM public.hot_updater_v1_bundle_events",
          )
        ).rows,
      ).toEqual([{ count: 2 }]);
      expect(
        (
          await database.query(
            "SELECT has_function_privilege('anon', 'public.hot_updater_v1_record_insights(jsonb,jsonb)', 'EXECUTE') AS allowed",
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
      expect(
        (
          await database.query(
            "SELECT has_function_privilege('service_role', 'public.hot_updater_v1_record_insights(jsonb,jsonb)', 'EXECUTE') AS allowed",
          )
        ).rows,
      ).toEqual([{ allowed: true }]);
    } finally {
      await database.close();
    }
  });

  it("ships the initial schema and a non-destructive Insights migration", async () => {
    const migrations = await readMigrations();
    expect(migrations.map(({ file }) => file)).toEqual([
      "20260818000000_hot-updater_1.0.0.sql",
      "20260905000000_hot-updater_1.0.1.sql",
    ]);
  });

  it("creates namespaced tables, RLS, and functions", async () => {
    const sql = await fs.readFile(migrationPath, "utf8");

    expect(sql).toContain("CREATE TABLE public.hot_updater_v1_channels");
    expect(sql).toContain("CREATE TABLE public.hot_updater_v1_bundles");
    expect(sql).toContain("CREATE TABLE public.hot_updater_v1_releases");
    expect(sql).toContain(
      "CREATE TABLE public.hot_updater_v1_release_catalogs",
    );
    expect(sql).toContain("CREATE TABLE public.hot_updater_v1_bundle_events");
    expect(sql).toContain(
      "CREATE TABLE public.hot_updater_v1_bundle_installations",
    );
    expect(sql).toContain(
      "hot_updater_v1_bundle_installations(user_id, install_id)",
    );
    expect(sql).toContain(
      "hot_updater_v1_bundle_installations(received_at_ms)",
    );
    expect(sql).toContain(
      "hot_updater_v1_bundle_events(install_id, type, received_at_ms, id)",
    );
    expect(sql).toContain("CREATE TABLE public.hot_updater_v1_api_keys");
    expect(sql).toContain(
      "ALTER TABLE public.hot_updater_v1_bundles ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "CREATE FUNCTION public.hot_updater_v1_commit(p_commit jsonb)",
    );
    expect(sql).toContain(
      "CREATE FUNCTION public.hot_updater_v1_delete_channel(p_id text)",
    );
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION");
    expect(sql).toContain("TO service_role;");
    expect(sql).toContain("archive_byte_size double precision NOT NULL CHECK");
    expect(sql).toContain("byte_size double precision NOT NULL CHECK");
    expect(sql).toContain("archive_byte_size = v_bundle.archive_byte_size");
    expect(sql).toContain(
      "patch_file_hash, patch_storage_uri, byte_size, order_index",
    );
    expect(sql).toContain("NOTIFY pgrst, 'reload schema'");
    expect(sql).not.toContain("get_update_info");
    expect(sql).not.toContain("ALTER TABLE public.bundles ADD COLUMN");
    expect(sql).not.toContain("WHEN 'insights'");
    expect(sql).not.toContain("v_event public.hot_updater_v1_bundle_events");
  });

  it("applies beside a v0 schema without modifying v0 data", async () => {
    const database = new PGlite();
    try {
      await database.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
      );
      await database.exec(`
        CREATE TABLE public.channels (id text PRIMARY KEY, name text NOT NULL);
        CREATE TABLE public.bundles (
          id uuid PRIMARY KEY,
          target_app_version text NOT NULL
        );
        INSERT INTO public.channels (id, name)
          VALUES ('legacy-channel', 'legacy');
        INSERT INTO public.bundles (id, target_app_version)
          VALUES ('00000000-0000-0000-0000-000000000099', '0.85.0');
      `);
      for (const migration of await readMigrations()) {
        await database.exec(migration.sql);
      }

      const tables = await database.query<{ tablename: string }>(`
        select tablename from pg_tables
        where schemaname = 'public'
        order by tablename
      `);
      expect(tables.rows.map(({ tablename }) => tablename)).toEqual(
        expect.arrayContaining([
          "hot_updater_v1_bundles",
          "hot_updater_v1_bundle_events",
          "hot_updater_v1_bundle_installations",
          "hot_updater_v1_bundle_patches",
          "hot_updater_v1_channels",
          "hot_updater_v1_api_keys",
          "hot_updater_v1_private_settings",
          "hot_updater_v1_release_catalogs",
          "hot_updater_v1_releases",
        ]),
      );

      await database.exec(`
        INSERT INTO public.hot_updater_v1_channels (id, name)
          VALUES ('channel-1', 'production');
        INSERT INTO public.hot_updater_v1_bundles (
          id, platform, file_hash, storage_uri, archive_byte_size, metadata
        ) VALUES (
          '00000000-0000-0000-0000-000000000001', 'ios', 'hash',
          'storage://bundle', 3000000001, '{}'::jsonb
        );
        INSERT INTO public.hot_updater_v1_bundle_patches (
          id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
          patch_storage_uri, byte_size
        ) VALUES (
          'patch-1', '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000001', 'base-hash', 'patch-hash',
          'storage://patch', 3000000002
        );
      `);
      const channels = await database.query<{ name: string }>(
        "SELECT name FROM public.hot_updater_v1_channels",
      );
      expect(channels.rows).toEqual([{ name: "production" }]);
      const legacyChannels = await database.query<{ name: string }>(
        "SELECT name FROM public.channels",
      );
      expect(legacyChannels.rows).toEqual([{ name: "legacy" }]);
      const sizes = await database.query<{
        archive_byte_size: number;
        byte_size: number;
      }>(`
        SELECT bundle.archive_byte_size, patch.byte_size
        FROM public.hot_updater_v1_bundles AS bundle
        JOIN public.hot_updater_v1_bundle_patches AS patch
          ON patch.bundle_id = bundle.id
      `);
      expect(sizes.rows).toEqual([
        { archive_byte_size: 3_000_000_001, byte_size: 3_000_000_002 },
      ]);
    } finally {
      await database.close();
    }
  });
});
