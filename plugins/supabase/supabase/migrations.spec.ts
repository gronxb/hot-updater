import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const rlsMigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260520014100_hot-updater_rls.sql",
);
const databaseV2MigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260713000000_hot-updater_0.36.0.sql",
);
const migrationsDir = path.dirname(rlsMigrationPath);

describe("Supabase RLS migration", () => {
  it("runs after Supabase function redefinition migrations", async () => {
    const migrations = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    expect(migrations.at(-1)).toBe(path.basename(databaseV2MigrationPath));
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
    const sql = await fs.readFile(databaseV2MigrationPath, "utf8");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.channels");
    expect(sql).toContain(
      "SELECT DISTINCT channel, channel FROM public.bundles",
    );
    expect(sql).toContain("name text NOT NULL UNIQUE");
    expect(sql).toContain("SET channel_id = channel");
    expect(sql).toContain("REFERENCES public.channels(id) ON DELETE RESTRICT");
    expect(
      sql.indexOf("SELECT DISTINCT channel, channel FROM public.bundles"),
    ).toBeLessThan(
      sql.indexOf("REFERENCES public.channels(id) ON DELETE RESTRICT"),
    );
    expect(sql).toContain("DROP COLUMN channel");
    expect(sql).toContain("JOIN channels c ON c.id = b.channel_id");
    expect(sql).toContain("c.name = target_channel");
    expect(sql).toContain(
      "ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;",
    );
  });
});
