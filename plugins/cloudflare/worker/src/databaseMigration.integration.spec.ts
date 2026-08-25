import { env } from "cloudflare:test";
import { expect, inject, it } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    d1Migrations: readonly {
      readonly name: string;
      readonly sql: string;
    }[];
  }
}

it("ships a single D1 1.0.0 CREATE migration", () => {
  expect(inject("d1Migrations").map(({ name }) => name)).toEqual([
    "0001_hot-updater_1.0.0.sql",
  ]);
});

it("creates official-domain tables on an empty database", async () => {
  for (const migration of inject("d1Migrations")) {
    await env.DB.prepare(migration.sql).run();
  }

  const tables = await env.DB.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name
  `).all<{ name: string }>();

  expect(tables.results.map(({ name }) => name)).toEqual(
    expect.arrayContaining([
      "bundle_events",
      "bundle_patches",
      "bundles",
      "channels",
      "api_keys",
      "private_hot_updater_settings",
      "release_catalogs",
      "releases",
    ]),
  );

  const version = await env.DB.prepare(
    "SELECT value FROM private_hot_updater_settings WHERE key = 'schema.core'",
  ).first<string>("value");
  expect(version).toBe("1.0.0");

  await env.DB.prepare(
    "INSERT INTO channels (id, name) VALUES ('channel-1', 'production')",
  ).run();
  await env.DB.prepare(`
    INSERT INTO bundles (
      id, platform, file_hash, storage_uri, archive_byte_size, metadata
    ) VALUES (
      '00000000-0000-0000-0000-000000000001', 'ios', 'hash',
      'storage://bundle', 3000000001, '{}'
    )
  `).run();
  await env.DB.prepare(`
    INSERT INTO bundle_patches (
      id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
      patch_storage_uri, patch_byte_size
    ) VALUES (
      'patch-1', '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001', 'base-hash', 'patch-hash',
      'storage://patch', 3000000002
    )
  `).run();
  await env.DB.prepare(`
    INSERT INTO releases (
      id, revision, scope_key, channel_id, platform, kind, bundle_id,
      strategy, target_app_version, fingerprint_hash, enabled,
      should_force_update, message, rollout_cohort_count, target_cohorts,
      operation, source_release_id, created_at_ms, updated_at_ms
    ) VALUES (
      '00000000-0000-0000-0000-000000000001', 1, 'scope', 'channel-1',
      'ios', 'BUNDLE', '00000000-0000-0000-0000-000000000001',
      'APP_VERSION', '1.0.0', NULL, 1, 0, NULL, 1000, '[]',
      'DEPLOY', NULL, 0, 0
    )
  `).run();

  const release = await env.DB.prepare(
    "SELECT channel_id, bundle_id FROM releases",
  ).first();
  expect(release).toEqual({
    channel_id: "channel-1",
    bundle_id: "00000000-0000-0000-0000-000000000001",
  });
  const sizes = await env.DB.prepare(`
    SELECT bundle.archive_byte_size, patch.patch_byte_size
    FROM bundles AS bundle
    JOIN bundle_patches AS patch ON patch.bundle_id = bundle.id
  `).first();
  expect(sizes).toEqual({
    archive_byte_size: 3_000_000_001,
    patch_byte_size: 3_000_000_002,
  });
});
