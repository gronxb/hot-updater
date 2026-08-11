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

  it("installs a service-role-only atomic commit function", async () => {
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

  it("rolls back every bundle mutation when one update target is missing", async () => {
    const database = new PGlite();
    try {
      await database.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;",
      );
      const migrationDirectory = path.resolve(
        "plugins/supabase/supabase/migrations",
      );
      const migrations = (await fs.readdir(migrationDirectory))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      for (const migration of migrations) {
        await database.exec(
          await fs.readFile(path.join(migrationDirectory, migration), "utf8"),
        );
      }

      const existingId = "00000000-0000-0000-0000-000000000001";
      const missingId = "00000000-0000-0000-0000-000000000002";
      await database.exec(`
        INSERT INTO public.bundles (
          id, platform, target_app_version, should_force_update, enabled,
          file_hash, channel, storage_uri, metadata, rollout_cohort_count
        ) VALUES (
          '${existingId}', 'ios', '1.0.0', false, true,
          'hash', 'production', 'storage://bundle', '{}', 1000
        );
      `);
      const mutations = [
        {
          operation: "update",
          bundleId: existingId,
          changes: [
            {
              table: "bundles",
              operation: "update",
              id: existingId,
              update: { message: "must-roll-back" },
            },
          ],
        },
        {
          operation: "update",
          bundleId: missingId,
          changes: [
            {
              table: "bundles",
              operation: "update",
              id: missingId,
              update: { message: "missing" },
            },
          ],
        },
      ];

      const commit = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_commit($1::jsonb) AS result",
        [JSON.stringify(mutations)],
      );
      const row = await database.query<{ message: string | null }>(
        "SELECT message FROM public.bundles WHERE id = $1",
        [existingId],
      );

      expect(commit.rows[0]?.result).toEqual({
        applied: false,
        missingBundleId: missingId,
      });
      expect(row.rows).toEqual([{ message: null }]);

      await database.exec(`
        INSERT INTO public.bundles (
          id, platform, target_app_version, should_force_update, enabled,
          file_hash, channel, storage_uri, metadata, rollout_cohort_count
        ) VALUES (
          '${missingId}', 'android', '1.0.0', false, true,
          'hash-2', 'production', 'storage://bundle-2', '{}', 1000
        );
      `);
      const successfulCommit = await database.query<{ result: unknown }>(
        "SELECT public.hot_updater_commit($1::jsonb) AS result",
        [JSON.stringify(mutations)],
      );
      const updatedRows = await database.query<{
        id: string;
        message: string | null;
      }>("SELECT id, message FROM public.bundles ORDER BY id");

      expect(successfulCommit.rows[0]?.result).toEqual({ applied: true });
      expect(updatedRows.rows).toEqual([
        { id: existingId, message: "must-roll-back" },
        { id: missingId, message: "missing" },
      ]);
    } finally {
      await database.close();
    }
  });
});
