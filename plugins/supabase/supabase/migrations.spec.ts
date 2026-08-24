import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

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
  it("ships a single 1.0.0 CREATE migration", async () => {
    const migrations = await readMigrations();
    expect(migrations.map(({ file }) => file)).toEqual([
      "20260818000000_hot-updater_1.0.0.sql",
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
    expect(sql).not.toContain("get_update_info");
    expect(sql).not.toContain("ALTER TABLE public.bundles ADD COLUMN");
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
          id, platform, file_hash, storage_uri, metadata
        ) VALUES (
          '00000000-0000-0000-0000-000000000001', 'ios', 'hash',
          'storage://bundle', '{}'::jsonb
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
    } finally {
      await database.close();
    }
  });
});
