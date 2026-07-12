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

const insertBundle = (id: string, channel: string): D1PreparedStatement =>
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
  await insertBundle("base", "production").run();
  await insertBundle("target", "production").run();
  await env.DB.prepare(`
    INSERT INTO bundle_patches (
      id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
      patch_storage_uri, order_index
    ) VALUES ('patch', 'target', 'base', 'base-hash', 'patch-hash',
      'storage://patch', 0)
  `).run();
  const latest = migrations.at(-1);
  if (latest === undefined) throw new MissingD1MigrationError();
  await env.DB.prepare(latest).run();
});

it("backfills channels and preserves bundle patch rows", async () => {
  const channel = await env.DB.prepare(
    "SELECT id FROM channels WHERE id = 'production'",
  ).first();
  const patch = await env.DB.prepare(
    "SELECT id FROM bundle_patches WHERE id = 'patch'",
  ).first();

  expect(channel).toEqual({ id: "production" });
  expect(patch).toEqual({ id: "patch" });
});

it("enforces the bundles channel foreign key after migration", async () => {
  await expect(insertBundle("invalid", "missing").run()).rejects.toThrow();
});
