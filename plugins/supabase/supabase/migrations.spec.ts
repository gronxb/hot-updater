import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const rlsMigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260520014100_hot-updater_rls.sql",
);
const migrationsDir = path.dirname(rlsMigrationPath);

describe("Supabase RLS migration", () => {
  it("runs after Supabase function redefinition migrations", async () => {
    const migrations = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const rlsMigration = path.basename(rlsMigrationPath);

    expect(migrations.indexOf(rlsMigration)).toBeGreaterThan(
      migrations.indexOf("20260422000000_hot-updater_0.31.0.sql"),
    );
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
});
