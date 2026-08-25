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
    expect(sql).toContain("CREATE TABLE public.api_keys");
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
    expect(sql).toContain("archive_byte_size double precision NOT NULL CHECK");
    expect(sql).toContain("patch_byte_size double precision NOT NULL CHECK");
    expect(sql).toContain("archive_byte_size = v_bundle.archive_byte_size");
    expect(sql).toContain(
      "patch_file_hash, patch_storage_uri, patch_byte_size, order_index",
    );
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
          "api_keys",
          "private_hot_updater_settings",
          "release_catalogs",
          "releases",
        ]),
      );

      await database.exec(`
        INSERT INTO public.channels (id, name) VALUES ('channel-1', 'production');
        INSERT INTO public.bundles (
          id, platform, file_hash, storage_uri, archive_byte_size, metadata
        ) VALUES (
          '00000000-0000-0000-0000-000000000001', 'ios', 'hash',
          'storage://bundle', 3000000001, '{}'::jsonb
        );
        INSERT INTO public.bundle_patches (
          id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
          patch_storage_uri, patch_byte_size
        ) VALUES (
          'patch-1', '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000001', 'base-hash', 'patch-hash',
          'storage://patch', 3000000002
        );
      `);
      const channels = await database.query<{ name: string }>(
        "SELECT name FROM public.channels",
      );
      expect(channels.rows).toEqual([{ name: "production" }]);
      const sizes = await database.query<{
        archive_byte_size: number;
        patch_byte_size: number;
      }>(`
        SELECT bundle.archive_byte_size, patch.patch_byte_size
        FROM public.bundles AS bundle
        JOIN public.bundle_patches AS patch ON patch.bundle_id = bundle.id
      `);
      expect(sizes.rows).toEqual([
        { archive_byte_size: 3_000_000_001, patch_byte_size: 3_000_000_002 },
      ]);
    } finally {
      await database.close();
    }
  });
});
