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

const insertNormalizedBundle = (
  id: string,
  channelId: string,
): D1PreparedStatement =>
  env.DB.prepare(`
    INSERT INTO bundles (
      id, platform, target_app_version, should_force_update, enabled,
      file_hash, git_commit_hash, message, channel_id, storage_uri,
      fingerprint_hash, metadata, rollout_cohort_count, target_cohorts,
      manifest_storage_uri, manifest_file_hash, asset_base_storage_uri
    ) VALUES (?, 'ios', '1.0.0', 0, 1, 'hash', NULL, NULL, ?,
      'storage://bundle', NULL, '{}', 1000, NULL, NULL, NULL, NULL)
  `).bind(id, channelId);

beforeAll(async () => {
  const migrations = inject("d1Migrations");
  for (const migration of migrations.slice(0, -2)) {
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
  const databaseV2 = migrations.at(-2);
  const analytics = migrations.at(-1);
  if (databaseV2 === undefined || analytics === undefined) {
    throw new MissingD1MigrationError();
  }
  await env.DB.prepare(databaseV2).run();
  await env.DB.prepare(analytics).run();
});

it("backfills channel names and bundle channel ids while preserving patches", async () => {
  const channel = await env.DB.prepare(
    "SELECT id, name FROM channels WHERE id = 'production'",
  ).first();
  const bundle = await env.DB.prepare(
    "SELECT channel, channel_id FROM bundles WHERE id = 'target'",
  ).first();
  const patch = await env.DB.prepare(
    "SELECT id FROM bundle_patches WHERE id = 'patch'",
  ).first();

  expect(channel).toEqual({ id: "production", name: "production" });
  expect(bundle).toEqual({
    channel: "production",
    channel_id: "production",
  });
  expect(patch).toEqual({ id: "patch" });
});

it("enforces the bundles channel id foreign key after migration", async () => {
  await expect(
    insertNormalizedBundle("invalid", "missing").run(),
  ).rejects.toThrow();
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

it("can safely rerun the latest analytics migration", async () => {
  const latest = inject("d1Migrations").at(-1);
  if (latest === undefined) throw new MissingD1MigrationError();

  await expect(env.DB.prepare(latest).run()).resolves.toBeDefined();
});
