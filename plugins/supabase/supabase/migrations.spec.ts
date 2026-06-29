import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const rlsMigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260520014100_hot-updater_rls.sql",
);
const telemetryMigrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260629000000_hot-updater_telemetry.sql",
);
const migrationsDir = path.dirname(rlsMigrationPath);

describe("Supabase RLS migration", () => {
  it("runs after Supabase function redefinition migrations", async () => {
    const migrations = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    expect(migrations.indexOf(path.basename(rlsMigrationPath))).toBeGreaterThan(
      migrations.indexOf("20260422000000_hot-updater_0.31.0.sql"),
    );
    expect(migrations.at(-1)).toBe(path.basename(telemetryMigrationPath));
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

  it("creates telemetry key and lifecycle storage without raw keys", async () => {
    const sql = await fs.readFile(telemetryMigrationPath, "utf8");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.telemetry_keys");
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS public.bundle_lifecycle_events",
    );
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS public.bundle_lifecycle_metrics",
    );
    expect(sql).toContain("key_hash text NOT NULL");
    expect(sql).toContain("key_suffix text NOT NULL");
    expect(sql).toContain(
      "ALTER TABLE public.telemetry_keys ENABLE ROW LEVEL SECURITY;",
    );
    expect(sql).toContain(
      "ALTER TABLE public.bundle_lifecycle_events ENABLE ROW LEVEL SECURITY;",
    );
    expect(sql).toContain(
      "ALTER TABLE public.bundle_lifecycle_metrics ENABLE ROW LEVEL SECURITY;",
    );
    expect(sql).not.toMatch(/\btelemetry_key\s+text\b/i);
    expect(sql).not.toMatch(/\bkey\s+text\b/i);
  });

  it("creates an atomic lifecycle metric increment function", async () => {
    const sql = await fs.readFile(telemetryMigrationPath, "utf8");

    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.increment_bundle_lifecycle_metric",
    );
    expect(sql).toContain("ON CONFLICT (bundle_id, bucket_start) DO UPDATE");
    expect(sql).toContain(
      "active_count = metrics.active_count + EXCLUDED.active_count",
    );
    expect(sql).toContain(
      "recovered_count = metrics.recovered_count + EXCLUDED.recovered_count",
    );
    expect(sql).toContain(
      "last_seen_at = GREATEST(metrics.last_seen_at, EXCLUDED.last_seen_at)",
    );
  });
});
