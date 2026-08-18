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

  it("creates official-domain tables, RLS, and the commit function", async () => {
    const sql = await fs.readFile(migrationPath, "utf8");

    expect(sql).toContain("CREATE TABLE public.channels");
    expect(sql).toContain("CREATE TABLE public.bundles");
    expect(sql).toContain("CREATE TABLE public.releases");
    expect(sql).toContain("CREATE TABLE public.release_catalogs");
    expect(sql).toContain("CREATE TABLE public.bundle_events");
    expect(sql).toContain("CREATE TABLE public.client_access_keys");
    expect(sql).toContain(
      "ALTER TABLE public.bundles ENABLE ROW LEVEL SECURITY",
    );
    expect(sql).toContain(
      "CREATE FUNCTION public.hot_updater_commit(p_commit jsonb)",
    );
    expect(sql).toContain(
      "CREATE FUNCTION public.hot_updater_delete_channel(p_id text)",
    );
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION");
    expect(sql).toContain("TO service_role;");
    expect(sql).not.toContain("get_update_info");
    expect(sql).not.toContain("ALTER TABLE public.bundles ADD COLUMN");
  });

  it("applies to an empty database", async () => {
    const database = new PGlite();
    try {
      await database.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
      );
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
          "bundles",
          "bundle_events",
          "bundle_patches",
          "channels",
          "client_access_keys",
          "private_hot_updater_settings",
          "release_catalogs",
          "releases",
        ]),
      );

      await database.exec(`
        INSERT INTO public.channels (id, name) VALUES ('channel-1', 'production');
        INSERT INTO public.bundles (
          id, platform, file_hash, storage_uri, metadata
        ) VALUES (
          '00000000-0000-0000-0000-000000000001', 'ios', 'hash',
          'storage://bundle', '{}'::jsonb
        );
      `);
      const channels = await database.query<{ name: string }>(
        "SELECT name FROM public.channels",
      );
      expect(channels.rows).toEqual([{ name: "production" }]);
    } finally {
      await database.close();
    }
  });
});
