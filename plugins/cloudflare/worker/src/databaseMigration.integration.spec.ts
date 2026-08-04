import { env } from "cloudflare:test";
import { beforeAll, expect, inject, it } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    d1Migrations: readonly string[];
  }
}

class MissingD1MigrationError extends Error {
  readonly name = "MissingD1MigrationError";
}

const insertLegacyBundle = (id: string, channel: string): D1PreparedStatement =>
  env.DB.prepare(`
    INSERT INTO bundles (
      id, platform, target_app_version, should_force_update, enabled,
      file_hash, git_commit_hash, message, channel, storage_uri,
      fingerprint_hash, metadata, rollout_cohort_count, target_cohorts
    ) VALUES (?, 'ios', '1.0.0', 0, 1, 'hash', NULL, NULL, ?,
      'storage://bundle', NULL, '{}', 1000, NULL)
  `).bind(id, channel);

beforeAll(async () => {
  const migrations = inject("d1Migrations");
  for (const migration of migrations.slice(0, -1)) {
    await env.DB.prepare(migration).run();
  }
  await insertLegacyBundle("base", "production").run();
  await insertLegacyBundle("target", "production").run();
  await env.DB.prepare(`
    CREATE TABLE bundle_migration_extension (
      bundle_id TEXT PRIMARY KEY,
      marker TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    INSERT INTO bundle_migration_extension (bundle_id, marker)
    VALUES ('seed', 'before-migration')
  `).run();
  await env.DB.prepare(`
    CREATE TRIGGER bundles_extension_trigger
    AFTER INSERT ON bundles
    BEGIN
      INSERT INTO bundle_migration_extension (bundle_id, marker)
      VALUES (NEW.id, 'triggered');
    END
  `).run();
  const migration = migrations.at(-1);
  if (migration === undefined) {
    throw new MissingD1MigrationError();
  }
  await env.DB.prepare(migration).run();
  await env.DB.prepare(`
    INSERT INTO bundle_patches (
      id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
      patch_storage_uri, order_index
    ) VALUES ('patch', 'target', 'base', 'base-hash', 'patch-hash',
      'storage://patch', 0)
  `).run();
});

it("preserves bundle channels and patches", async () => {
  const bundle = await env.DB.prepare(
    "SELECT channel FROM bundles WHERE id = 'target'",
  ).first();
  const patch = await env.DB.prepare(
    "SELECT id FROM bundle_patches WHERE id = 'patch'",
  ).first();

  expect(bundle).toEqual({ channel: "production" });
  expect(patch).toEqual({ id: "patch" });
});

it("preserves extension tables and triggers through migration", async () => {
  const extensionRow = await env.DB.prepare(
    "SELECT marker FROM bundle_migration_extension WHERE bundle_id = 'seed'",
  ).first();

  expect(extensionRow).toEqual({ marker: "before-migration" });

  await insertLegacyBundle("triggered", "preview").run();
  const triggerRow = await env.DB.prepare(
    "SELECT marker FROM bundle_migration_extension WHERE bundle_id = 'triggered'",
  ).first();

  expect(triggerRow).toEqual({ marker: "triggered" });
});

it("accepts channels directly on new bundles after migration", async () => {
  await expect(
    insertLegacyBundle("preview", "preview").run(),
  ).resolves.toBeDefined();
});
