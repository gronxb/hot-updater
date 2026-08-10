import { env } from "cloudflare:test";
import { beforeAll, expect, inject, it } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    d1Migrations: readonly {
      readonly name: string;
      readonly sql: string;
    }[];
  }
}

class MissingD1MigrationError extends Error {
  readonly name = "MissingD1MigrationError";
}

const getMigration = (name: string): string => {
  const migration = inject("d1Migrations").find(
    (candidate) => candidate.name === name,
  );
  if (migration === undefined) {
    throw new MissingD1MigrationError(name);
  }
  return migration.sql;
};

const applyMigration = (name: string) =>
  env.DB.prepare(getMigration(name)).run();

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
  for (const migration of migrations.filter(
    ({ name }) => name < "0005_hot-updater_0.31.0.sql",
  )) {
    await env.DB.prepare(migration.sql).run();
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
  await applyMigration("0005_hot-updater_0.31.0.sql");
  await env.DB.prepare(`
    INSERT INTO bundle_patches (
      id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
      patch_storage_uri, order_index
    ) VALUES ('patch', 'target', 'base', 'base-hash', 'patch-hash',
      'storage://patch', 0)
  `).run();
  await applyMigration("0006_hot-updater_0.36.0.sql");
  await env.DB.prepare(`
    INSERT INTO private_hot_updater_settings (key, value)
    VALUES ('version', '0.31.0'), ('schema.extension', '2'), ('extension', 'kept')
  `).run();
  await applyMigration("0006_hot-updater_0.36.0.sql");
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

it("records the Core schema without replacing other settings", async () => {
  const settings = await env.DB.prepare(`
    SELECT key, value
    FROM private_hot_updater_settings
    ORDER BY key
  `).all();

  expect(settings.results).toEqual([
    { key: "extension", value: "kept" },
    { key: "schema.core", value: "0.36.0" },
    { key: "schema.extension", value: "2" },
    { key: "version", value: "0.31.0" },
  ]);
});

it("fails closed when a different Core schema marker already exists", async () => {
  await env.DB.prepare(`
    UPDATE private_hot_updater_settings
    SET value = '0.38.0'
    WHERE key = 'schema.core'
  `).run();

  try {
    await expect(
      applyMigration("0006_hot-updater_0.36.0.sql"),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(`
        SELECT value
        FROM private_hot_updater_settings
        WHERE key = 'schema.core'
      `).first("value"),
    ).resolves.toBe("0.38.0");
  } finally {
    await env.DB.prepare(`
      UPDATE private_hot_updater_settings
      SET value = '0.36.0'
      WHERE key = 'schema.core'
    `).run();
  }
});
