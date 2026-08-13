import { env } from "cloudflare:test";
import { beforeAll, expect, inject, it } from "vitest";

import {
  type D1BundleSchemaRow,
  materializeCloudflareReleaseCatalogMigration,
} from "../../iac/cloudflareReleaseCatalogMigration";

declare module "vitest" {
  export interface ProvidedContext {
    d1Migrations: readonly {
      readonly name: string;
      readonly sql: string;
    }[];
  }
}

const migrations = inject("d1Migrations");
const getMigration = (name: string): string => {
  const migration = migrations.find((candidate) => candidate.name === name);
  if (!migration) throw new Error(`Missing D1 migration: ${name}`);
  return migration.sql;
};

beforeAll(async () => {
  for (const migration of migrations.filter(({ name }) => name < "0009")) {
    await env.DB.prepare(migration.sql).run();
  }
  await env.DB.prepare(`
    INSERT INTO channels (id, name) VALUES ('channel-production', 'production');
    INSERT INTO bundles (
      id, platform, target_app_version, should_force_update, enabled,
      file_hash, git_commit_hash, message, channel, channel_id, storage_uri,
      fingerprint_hash, metadata, rollout_cohort_count, target_cohorts,
      manifest_storage_uri, manifest_file_hash, asset_base_storage_uri
    ) VALUES (
      '00000000-0000-7000-8000-000000000071', 'ios', '^1.0.0', 0, 1,
      'hash-1', NULL, NULL, 'production', 'channel-production',
      'storage://bundle-1', NULL, '{}', 1000, '[]', NULL, NULL, NULL
    ), (
      '00000000-0000-7000-8000-000000000072', 'ios', '^1.0.0', 1, 1,
      'hash-2', NULL, 'critical', 'production', 'channel-production',
      'storage://bundle-2', NULL, '{}', 500, '["qa"]', NULL, NULL, NULL
    );
    INSERT INTO bundle_patches (
      id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
      patch_storage_uri, order_index
    ) VALUES (
      'patch', '00000000-0000-7000-8000-000000000072',
      '00000000-0000-7000-8000-000000000071', 'base-hash', 'patch-hash',
      'storage://patch', 0
    );
    CREATE TABLE bundle_migration_extension (
      bundle_id TEXT PRIMARY KEY,
      marker TEXT NOT NULL
    );
    CREATE TRIGGER retained_bundle_trigger
    AFTER UPDATE OF file_hash ON bundles
    BEGIN
      INSERT INTO bundle_migration_extension (bundle_id, marker)
      VALUES (NEW.id, 'retained');
    END;
  `).run();

  const schema = await env.DB.prepare(`
    SELECT type, name, sql
    FROM sqlite_schema
    WHERE tbl_name = 'bundles'
      AND type IN ('table', 'index', 'trigger')
    ORDER BY type, name
  `).all<D1BundleSchemaRow>();
  const legacy = await env.DB.prepare(`
    SELECT id, platform, channel, enabled, should_force_update, message,
      target_app_version, fingerprint_hash, rollout_cohort_count,
      target_cohorts
    FROM bundles
    ORDER BY id
  `).all();
  const sql = await materializeCloudflareReleaseCatalogMigration({
    authorityId: "database-id",
    migrationSql: getMigration("0009_hot-updater_1.0.0.sql"),
    state: {
      bundleSchema: schema.results,
      legacyBundles:
        legacy.results as import("@hot-updater/server").LegacyBundlePolicyRow[],
    },
  });
  await env.DB.prepare(sql).run();
});

it("backfills Release history and a canonical catalog before removing Bundle policy", async () => {
  const columns = await env.DB.prepare("PRAGMA table_info(bundles)").all<{
    name: string;
  }>();
  expect(columns.results.map(({ name }) => name)).toEqual([
    "id",
    "platform",
    "file_hash",
    "git_commit_hash",
    "storage_uri",
    "metadata",
    "manifest_storage_uri",
    "manifest_file_hash",
    "asset_base_storage_uri",
  ]);
  const releases = await env.DB.prepare(
    "SELECT id, bundle_id, revision FROM releases ORDER BY id",
  ).all();
  expect(releases.results).toEqual([
    {
      bundle_id: "00000000-0000-7000-8000-000000000071",
      id: "00000000-0000-7000-8000-000000000071",
      revision: 1,
    },
    {
      bundle_id: "00000000-0000-7000-8000-000000000072",
      id: "00000000-0000-7000-8000-000000000072",
      revision: 1,
    },
  ]);
  const catalog = await env.DB.prepare(`
    SELECT authority_id, generation, catalog_hash, payload
    FROM release_catalogs
  `).first<{
    authority_id: string;
    catalog_hash: string;
    generation: number;
    payload: string;
  }>();
  expect(catalog).toMatchObject({ authority_id: "database-id", generation: 1 });
  expect(catalog?.catalog_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(JSON.parse(catalog?.payload ?? "")).toMatchObject({
    schemaVersion: 1,
    strategy: "APP_VERSION",
  });
});

it("preserves patches, compatible user triggers, and foreign-key integrity", async () => {
  await expect(
    env.DB.prepare("SELECT id FROM bundle_patches WHERE id = 'patch'").first(),
  ).resolves.toEqual({ id: "patch" });
  await env.DB.prepare(`
    UPDATE bundles SET file_hash = 'updated'
    WHERE id = '00000000-0000-7000-8000-000000000072'
  `).run();
  await expect(
    env.DB.prepare(`
      SELECT marker FROM bundle_migration_extension
      WHERE bundle_id = '00000000-0000-7000-8000-000000000072'
    `).first(),
  ).resolves.toEqual({ marker: "retained" });
  const foreignKeyCheck = await env.DB.prepare(
    "PRAGMA foreign_key_check",
  ).all();
  expect(foreignKeyCheck.results).toEqual([]);
  await expect(
    env.DB.prepare(`
      DELETE FROM bundles
      WHERE id = '00000000-0000-7000-8000-000000000072'
    `).run(),
  ).rejects.toThrow();
});

it("advances only the Core schema marker", async () => {
  const settings = await env.DB.prepare(`
    SELECT key, value FROM private_hot_updater_settings ORDER BY key
  `).all();
  expect(settings.results).toContainEqual({
    key: "schema.core",
    value: "1.0.0",
  });
});
