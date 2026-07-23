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
      fingerprint_hash, metadata, rollout_cohort_count, target_cohorts,
      manifest_storage_uri, manifest_file_hash, asset_base_storage_uri
    ) VALUES (?, 'ios', '1.0.0', 0, 1, 'hash', NULL, NULL, ?,
      'storage://bundle', NULL, '{}', 1000, NULL, NULL, NULL, NULL)
  `).bind(id, channel);

beforeAll(async () => {
  const migrations = inject("d1Migrations");
  for (const migration of migrations.slice(0, -1)) {
    await env.DB.prepare(migration).run();
  }
  await insertLegacyBundle("base", "production").run();
  await insertLegacyBundle("target", "production").run();
  await env.DB.prepare(`
    INSERT INTO bundle_patches (
      id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
      patch_storage_uri, order_index
    ) VALUES ('patch', 'target', 'base', 'base-hash', 'patch-hash',
      'storage://patch', 0)
  `).run();
  const migration = migrations.at(-1);
  if (migration === undefined) {
    throw new MissingD1MigrationError();
  }
  await env.DB.prepare(migration).run();
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

it("accepts channels directly on new bundles after migration", async () => {
  await expect(
    insertLegacyBundle("preview", "preview").run(),
  ).resolves.toBeDefined();
});

it("accepts UNCHANGED activity and rejects invalid event variants", async () => {
  const insert = (type: string, fromBundleId: string | null) =>
    env.DB.prepare(`
      INSERT INTO bundle_events (
        id, type, install_id, from_bundle_id, to_bundle_id, platform,
        app_version, channel, cohort, update_strategy, received_at_ms
      ) VALUES (?, ?, 'install', ?, 'target', 'ios', '1.0.0',
        'production', 'cohort', NULL, 1)
    `).bind(`event-${type}`, type, fromBundleId);

  await expect(insert("UNCHANGED", null).run()).resolves.toBeDefined();
  await expect(insert("UNKNOWN", null).run()).rejects.toThrow();
  await expect(insert("UPDATE_APPLIED", "base").run()).rejects.toThrow();
});

it("keeps the existing bundle and patch tables during migration", async () => {
  const migration = inject("d1Migrations").at(-1);
  if (migration === undefined) throw new MissingD1MigrationError();

  expect(migration).not.toContain("bundles_v2");
  expect(migration).not.toContain("bundle_patches_v2");
  expect(migration).not.toContain("DROP TABLE bundles");
  expect(migration).not.toContain("DROP TABLE bundle_patches");
  expect(migration).not.toContain("bundle_channels");
  expect(migration).not.toContain("channel_id");
});

it("fails a repeated v0.38 migration with the conflicting table name", async () => {
  // Given
  const migration = inject("d1Migrations").at(-1);
  if (migration === undefined) throw new MissingD1MigrationError();

  // When / Then
  await expect(env.DB.prepare(migration).run()).rejects.toThrow(
    "table bundle_events already exists",
  );
});
