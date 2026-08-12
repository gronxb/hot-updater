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
  await insertLegacyBundle("preview-seed", "preview").run();
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
    VALUES ('version', '0.31.0'), ('schema.analytics', '2'), ('extension', 'kept')
  `).run();
  await applyMigration("0006_hot-updater_0.36.0.sql");
  await applyMigration("0007_hot-updater_0.37.0.sql");
  await applyMigration("0008_hot-updater_0.38.0.sql");
});

it("preserves bundle channels and patches", async () => {
  const bundle = await env.DB.prepare(
    "SELECT channel, channel_id FROM bundles WHERE id = 'target'",
  ).first();
  const patch = await env.DB.prepare(
    "SELECT id FROM bundle_patches WHERE id = 'patch'",
  ).first();

  expect(bundle).toEqual({
    channel: "production",
    channel_id: expect.any(String),
  });
  expect(patch).toEqual({ id: "patch" });
});

it("preserves extension tables and bundle triggers through migration", async () => {
  const extensionRow = await env.DB.prepare(
    "SELECT marker FROM bundle_migration_extension WHERE bundle_id = 'seed'",
  ).first();

  expect(extensionRow).toEqual({ marker: "before-migration" });

  const previewChannelId = await env.DB.prepare(
    "SELECT id FROM channels WHERE name = 'preview'",
  ).first<string>("id");
  await env.DB.prepare(`
    INSERT INTO bundles (
      id, platform, target_app_version, should_force_update, enabled,
      file_hash, git_commit_hash, message, channel, channel_id, storage_uri,
      fingerprint_hash, metadata, rollout_cohort_count, target_cohorts
    ) VALUES ('triggered', 'ios', '1.0.0', 0, 1, 'hash', NULL, NULL,
      'preview', ?, 'storage://bundle', NULL, '{}', 1000, NULL)
  `)
    .bind(previewChannelId)
    .run();
  const triggerRow = await env.DB.prepare(
    "SELECT marker FROM bundle_migration_extension WHERE bundle_id = 'triggered'",
  ).first();

  expect(triggerRow).toEqual({ marker: "triggered" });
});

it("backfills one persistent row for every legacy channel", async () => {
  const channels = await env.DB.prepare(
    "SELECT id, name FROM channels ORDER BY name ASC",
  ).all();

  expect(channels.results).toEqual([
    { id: expect.any(String), name: "preview" },
    { id: expect.any(String), name: "production" },
  ]);

  await env.DB.prepare("DELETE FROM bundles WHERE channel = 'preview'").run();
  await expect(
    env.DB.prepare(
      "SELECT id, name FROM channels WHERE name = 'preview'",
    ).first(),
  ).resolves.toEqual({ id: expect.any(String), name: "preview" });
});

it("keeps the literal channel foreign key and rejects invalid references", async () => {
  const foreignKeys = await env.DB.prepare(
    "PRAGMA foreign_key_list(bundles)",
  ).all();
  expect(foreignKeys.results).toContainEqual(
    expect.objectContaining({
      table: "channels",
      from: "channel_id",
      to: "id",
    }),
  );

  await expect(
    env.DB.prepare(`
      INSERT INTO bundles (
        id, platform, target_app_version, should_force_update, enabled,
        file_hash, channel, channel_id, storage_uri, metadata,
        rollout_cohort_count
      ) VALUES ('missing-channel', 'ios', '1.0.0', 0, 1, 'hash',
        'missing', 'missing', 'storage://bundle', '{}', 1000)
    `).run(),
  ).rejects.toThrow();
});

it("rejects null and mismatched dual-written channel fields", async () => {
  const channelId = await env.DB.prepare(
    "SELECT id FROM channels WHERE name = 'production'",
  ).first<string>("id");
  await expect(
    env.DB.prepare(`
      INSERT INTO bundles (
        id, platform, target_app_version, should_force_update, enabled,
        file_hash, channel, channel_id, storage_uri, metadata,
        rollout_cohort_count
      ) VALUES ('null-channel', 'ios', '1.0.0', 0, 1, 'hash',
        'production', NULL, 'storage://bundle', '{}', 1000)
    `).run(),
  ).rejects.toThrow("bundles channel and channel_id must match");
  await expect(
    env.DB.prepare(`
      UPDATE bundles
      SET channel = 'preview', channel_id = ?
      WHERE id = 'target'
    `)
      .bind(channelId)
      .run(),
  ).rejects.toThrow("bundles channel and channel_id must match");
});

it("creates the official analytics and client access-key tables", async () => {
  await env.DB.prepare(`
    INSERT INTO bundle_events (
      id, type, install_id, user_id, username, from_bundle_id, to_bundle_id,
      platform, app_version, channel, cohort, update_strategy,
      fingerprint_hash, sdk_version, received_at_ms
    ) VALUES (
      'event', 'UNCHANGED', 'install', NULL, NULL, NULL, 'target',
      'ios', '1.0.0', 'production', '0', NULL, NULL, NULL, 1
    )
  `).run();
  await env.DB.prepare(`
    INSERT INTO client_access_keys (
      id, hash, name, prefix, role, created_at_ms, revoked_at_ms
    ) VALUES ('key', 'hash', 'Client', 'prefix', 'client', 1, NULL)
  `).run();

  await expect(
    env.DB.prepare("SELECT id FROM bundle_events WHERE id = 'event'").first(),
  ).resolves.toEqual({ id: "event" });
  await expect(
    env.DB.prepare(
      "SELECT id FROM client_access_keys WHERE id = 'key'",
    ).first(),
  ).resolves.toEqual({ id: "key" });
});

it("records the Core schema without replacing other settings", async () => {
  const settings = await env.DB.prepare(`
    SELECT key, value
    FROM private_hot_updater_settings
    ORDER BY key
  `).all();

  expect(settings.results).toEqual([
    { key: "extension", value: "kept" },
    { key: "schema.analytics", value: "2" },
    { key: "schema.core", value: "0.38.0" },
    { key: "version", value: "0.31.0" },
  ]);
});

it("fails closed for the obsolete preview Core marker", async () => {
  await expect(applyMigration("0007_hot-updater_0.37.0.sql")).rejects.toThrow();
  await expect(
    env.DB.prepare(`
      SELECT value
      FROM private_hot_updater_settings
      WHERE key = 'schema.core'
    `).first("value"),
  ).resolves.toBe("0.38.0");
});

it("fails closed when a different Core schema marker already exists", async () => {
  await env.DB.prepare(`
    UPDATE private_hot_updater_settings
    SET value = '0.39.0'
    WHERE key = 'schema.core'
  `).run();

  try {
    await expect(
      applyMigration("0007_hot-updater_0.37.0.sql"),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(`
        SELECT value
        FROM private_hot_updater_settings
        WHERE key = 'schema.core'
      `).first("value"),
    ).resolves.toBe("0.39.0");
  } finally {
    await env.DB.prepare(`
      UPDATE private_hot_updater_settings
      SET value = '0.38.0'
      WHERE key = 'schema.core'
    `).run();
  }
});
