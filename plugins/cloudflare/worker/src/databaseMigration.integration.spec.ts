import { env } from "cloudflare:test";
import { expect, inject, it } from "vitest";

import { createBundleEventRowFixture } from "../../../../packages/test-utils/src/databaseTestFixtures";
import { d1Database } from "../../src/worker";

declare module "vitest" {
  export interface ProvidedContext {
    d1Migrations: readonly {
      readonly name: string;
      readonly sql: string;
    }[];
  }
}

it("ships a single 1.0.0 initialization migration", () => {
  expect(inject("d1Migrations").map(({ name }) => name)).toEqual([
    "0001_hot-updater_1.0.0.sql",
  ]);
});

it("creates the current schema with required artifact sizes", async () => {
  const [createMigration] = inject("d1Migrations");
  await env.DB.prepare(createMigration!.sql).run();
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
      patch_storage_uri, byte_size
    ) VALUES (
      'patch-1', '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000001', 'base-hash', 'patch-hash',
      'storage://patch', 3000000002
    )
  `).run();

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
    SELECT bundle.archive_byte_size, patch.byte_size
    FROM bundles AS bundle
    JOIN bundle_patches AS patch ON patch.bundle_id = bundle.id
  `).first();
  expect(sizes).toEqual({
    archive_byte_size: 3_000_000_001,
    byte_size: 3_000_000_002,
  });

  expect(tables.results.map(({ name }) => name)).not.toContain(
    "bundle_installations",
  );
  const latestIndex = await env.DB.prepare(
    "PRAGMA index_info(bundle_events_latest_idx)",
  ).all<{ name: string }>();
  expect(latestIndex.results.map(({ name }) => name)).toEqual([
    "install_id",
    "received_at_ms",
    "id",
  ]);

  const movementIndex = await env.DB.prepare(
    "PRAGMA index_info(bundle_events_install_idx)",
  ).all<{ name: string }>();
  expect(movementIndex.results.map(({ name }) => name)).toEqual([
    "install_id",
    "type",
    "received_at_ms",
    "id",
  ]);

  for (const [direction, type] of [
    ["from", "RECOVERED"],
    ["to", "UPDATE_APPLIED"],
  ]) {
    const plan = await env.DB.prepare(`
      EXPLAIN QUERY PLAN SELECT * FROM bundle_events
      WHERE type = ? AND platform = 'ios' AND channel = 'production'
        AND ${direction}_bundle_id = ? AND received_at_ms >= 100 AND received_at_ms < 200
      ORDER BY received_at_ms DESC, id DESC LIMIT 101
    `)
      .bind(type, "00000000-0000-0000-0000-000000000001")
      .all<{ detail: string }>();
    expect(plan.results.map(({ detail }) => detail).join("\n")).toContain(
      `bundle_events_${direction}_bundle_idx`,
    );
    expect(plan.results.map(({ detail }) => detail).join("\n")).not.toContain(
      "TEMP B-TREE",
    );
  }

  for (const size of [-1, Number.MAX_SAFE_INTEGER + 1, null]) {
    await expect(
      env.DB.prepare("UPDATE bundles SET archive_byte_size = ?")
        .bind(size)
        .run(),
    ).rejects.toThrow(/constraint failed/);
    await expect(
      env.DB.prepare("UPDATE bundle_patches SET byte_size = ?")
        .bind(size)
        .run(),
    ).rejects.toThrow(/constraint failed/);
  }

  await expect(
    env.DB.prepare(`
      INSERT INTO bundles (id, platform, file_hash, storage_uri)
      VALUES ('missing-size', 'ios', 'hash', 'storage://bundle')
    `).run(),
  ).rejects.toThrow(/NOT NULL constraint failed/);
  await expect(
    env.DB.prepare(`
      INSERT INTO bundle_patches (
        id, bundle_id, base_bundle_id, base_file_hash, patch_file_hash,
        patch_storage_uri
      ) VALUES (
        'missing-size', '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000001', 'base-hash', 'patch-hash',
        'storage://patch'
      )
    `).run(),
  ).rejects.toThrow(/NOT NULL constraint failed/);
});

it("returns canonical downloaded and applied events from the initialized D1 schema", async () => {
  const plugin = d1Database(env.DB);
  const download = {
    ...createBundleEventRowFixture("9601", 100),
    type: "UPDATE_DOWNLOADED" as const,
    from_bundle_id: "00000000-0000-7000-8000-000000001001",
    metadata: {
      ...createBundleEventRowFixture("9601", 100).metadata,
      update_strategy: "appVersion" as const,
    },
  };
  await plugin.models.insights.record({
    event: download,
  });
  await expect(
    plugin.models.insights.findLatestEvents({
      installId: download.install_id,
    }),
  ).resolves.toEqual([download]);
  const applied = {
    ...download,
    id: createBundleEventRowFixture("9602", 200).id,
    type: "UPDATE_APPLIED" as const,
    received_at_ms: 200,
  };
  await plugin.models.insights.record({
    event: applied,
  });
  await plugin.models.insights.record({
    event: download,
  });
  await expect(
    plugin.models.insights.findLatestEvents({
      installId: download.install_id,
    }),
  ).resolves.toEqual([applied]);
  await expect(
    env.DB.prepare("UPDATE bundle_events SET type = 'UNCHANGED'").run(),
  ).rejects.toThrow(/bundle_events_shape_check/);
});
