import { env } from "cloudflare:test";
import { expect, inject, it } from "vitest";

import { createBundleEventRowFixture } from "../../../../packages/test-utils/src/databaseTestFixtures";
import type { D1Executor, D1Statement } from "../../src/d1Implementation";
import {
  createD1InsightsEventInsert,
  createD1InsightsSourceTools,
} from "../../src/d1InsightsSource";

declare module "vitest" {
  export interface ProvidedContext {
    d1Migrations: readonly {
      readonly name: string;
      readonly sql: string;
    }[];
  }
}

it("ships the core create and Insights v2 migrations", () => {
  expect(inject("d1Migrations").map(({ name }) => name)).toEqual([
    "0001_hot-updater_1.0.0.sql",
    "0002_hot-updater_insights-v2.sql",
  ]);
});

it("creates the core schema and upgrades its fixed legacy event prefix", async () => {
  const [createMigration, insightsMigration] = inject("d1Migrations");
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

  const legacy = {
    ...createBundleEventRowFixture("901", 100),
    id: "legacy/event-901",
  };
  const columns = Object.keys(legacy);
  await env.DB.prepare(
    `INSERT INTO bundle_events (${columns.join(",")}) VALUES (${columns
      .map(() => "?")
      .join(",")})`,
  )
    .bind(...Object.values(legacy))
    .run();
  await env.DB.prepare(insightsMigration!.sql).run();

  const source = createD1InsightsSourceTools(executor);
  await expect(source.capture()).rejects.toThrow();
  let loseFirstResponse = true;
  const uncertain = createD1InsightsSourceTools({
    query: executor.query,
    async batch(statements) {
      const result = await executor.batch(statements);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error("simulated response loss after D1 batch commit");
      }
      return result;
    },
  });
  await expect(uncertain.backfillStep(1)).rejects.toThrow(
    /simulated response loss/,
  );
  await expect(source.backfillStep(1)).resolves.toEqual({
    processed: 0,
    ready: true,
  });
  const firstGeneration = await source.capture();
  await expect(
    source.readPage({ sourceGeneration: firstGeneration, limit: 14 }),
  ).resolves.toEqual([{ generation: 1, event: legacy }]);

  const next = {
    ...createBundleEventRowFixture("902", 200),
    id: "direct:event:902",
  };
  const insert = await createD1InsightsEventInsert(next);
  await executor.batch([insert]);
  await expect(
    source.readPage({ sourceGeneration: firstGeneration, limit: 14 }),
  ).resolves.toEqual([{ generation: 1, event: legacy }]);
  const nextGeneration = await source.capture();
  await expect(
    source.readPage({
      sourceGeneration: nextGeneration,
      afterGeneration: 1,
      limit: 14,
    }),
  ).resolves.toEqual([{ generation: 2, event: next }]);
});

it("rejects an empty legacy event ID during v2 backfill", async () => {
  const [createMigration, insightsMigration] = inject("d1Migrations");
  await resetD1Schema();
  await env.DB.prepare(createMigration!.sql).run();
  const invalid = { ...createBundleEventRowFixture("903", 100), id: "" };
  const columns = Object.keys(invalid);
  await env.DB.prepare(
    `INSERT INTO bundle_events (${columns.join(",")}) VALUES (${columns
      .map(() => "?")
      .join(",")})`,
  )
    .bind(...Object.values(invalid))
    .run();
  await env.DB.prepare(insightsMigration!.sql).run();

  await expect(
    createD1InsightsSourceTools(executor).backfillStep(1),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare(
      "SELECT status FROM private_hot_updater_insights_source_state WHERE id = 1",
    ).first<string>("status"),
  ).resolves.toBe("preparing");
  await expect(
    env.DB.prepare(
      "SELECT count(*) count FROM private_hot_updater_insights_source_events",
    ).first<number>("count"),
  ).resolves.toBe(0);
});

it("seeks a 50,001-row legacy prefix and keeps a worst-case step below 50 queries", async () => {
  const [createMigration, insightsMigration] = inject("d1Migrations");
  await resetD1Schema();
  await env.DB.prepare(createMigration!.sql).run();
  await env.DB.prepare(`
    WITH RECURSIVE source(n) AS (
      VALUES (1) UNION ALL SELECT n + 1 FROM source WHERE n < 50001
    )
    INSERT INTO bundle_events (
      id, type, install_id, from_bundle_id, to_bundle_id, platform,
      app_version, channel, cohort, update_strategy, received_at_ms
    )
    SELECT
      printf('event-%05d', n),
      'UPDATE_APPLIED', 'install-' || n, 'from-bundle', 'to-bundle',
      'ios', '1.0.0', 'production', '0', 'appVersion', n
    FROM source
  `).run();
  await env.DB.prepare(insightsMigration!.sql).run();

  const plan = await env.DB.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id FROM bundle_events INDEXED BY bundle_events_received_at_idx
    WHERE (received_at_ms, id COLLATE BINARY) <= (50001, ? COLLATE BINARY)
    ORDER BY received_at_ms ASC, id COLLATE BINARY ASC LIMIT 6
  `)
    .bind("event-50001")
    .all<{ detail: string }>();
  expect(plan.results.map(({ detail }) => detail).join("\n")).toMatch(
    /SEARCH bundle_events USING (?:COVERING )?INDEX bundle_events_received_at_idx/,
  );
  expect(plan.results.map(({ detail }) => detail).join("\n")).not.toMatch(
    /SCAN bundle_events|USE TEMP B-TREE/,
  );

  let queryCount = 0;
  let batchStatements = 0;
  let rawRowsRead: number | null = null;
  const measured: D1Executor = {
    async query(sql, params) {
      queryCount += 1;
      const result = await env.DB.prepare(sql)
        .bind(...params)
        .all();
      if (
        /FROM bundle_events INDEXED BY bundle_events_received_at_idx/i.test(sql)
      ) {
        const meta = result.meta as { rows_read?: unknown };
        if (typeof meta.rows_read === "number") rawRowsRead = meta.rows_read;
      }
      return result.results;
    },
    async batch(statements) {
      batchStatements = statements.length;
      return executor.batch(statements);
    },
  };
  await expect(
    createD1InsightsSourceTools(measured).backfillStep(6),
  ).resolves.toEqual({ processed: 6, ready: false });
  expect(queryCount).toBe(3);
  expect(batchStatements).toBe(32);
  expect(queryCount + batchStatements).toBe(35);
  expect(rawRowsRead).not.toBeNull();
  expect(rawRowsRead!).toBeLessThanOrEqual(7);

  await env.DB.prepare(`
    DELETE FROM private_hot_updater_insights_live_installations;
    DELETE FROM private_hot_updater_insights_installation_events;
    DELETE FROM private_hot_updater_insights_bundle_events;
    DELETE FROM private_hot_updater_insights_source_events;
    INSERT INTO private_hot_updater_insights_source_events (
      generation, event_id, received_at_ms, row_bytes
    )
    SELECT CAST(received_at_ms AS INTEGER), id, received_at_ms, 256
    FROM bundle_events;
    INSERT INTO private_hot_updater_insights_installation_events (
      install_id, received_at_ms, event_id, row_bytes
    )
    SELECT install_id, received_at_ms, id, 256 FROM bundle_events;
    INSERT INTO private_hot_updater_insights_bundle_events (
      bundle_id, received_at_ms, event_id, row_bytes
    )
    SELECT to_bundle_id, received_at_ms, id, 256 FROM bundle_events;
    INSERT INTO private_hot_updater_insights_live_installations (
      install_key, install_id, event_id, received_at_ms, row_bytes
    )
    SELECT printf('%064x', CAST(received_at_ms AS INTEGER)), install_id, id,
      received_at_ms, 256 FROM bundle_events;
    UPDATE private_hot_updater_insights_source_state
    SET status = 'ready', generation = 50001,
      backfill_after_received_at_ms = backfill_upper_received_at_ms,
      backfill_after_id = backfill_upper_id
    WHERE id = 1;
  `).run();

  const measuredRead = async (
    sql: string,
    params: readonly unknown[],
    maximumRowsRead: number,
    planPattern: RegExp,
  ) => {
    const result = await env.DB.prepare(sql)
      .bind(...params)
      .all();
    const rowsRead = (result.meta as { rows_read?: unknown }).rows_read;
    expect(rowsRead).toEqual(expect.any(Number));
    expect(rowsRead as number).toBeLessThanOrEqual(maximumRowsRead);
    const explained = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    const detail = explained.results.map((row) => row.detail).join("\n");
    expect(detail).toMatch(planPattern);
    expect(detail).not.toMatch(/USE TEMP B-TREE/);
    return result.results;
  };
  const sourceRows = await measuredRead(
    `SELECT generation, event_id FROM private_hot_updater_insights_source_events
      WHERE generation > json_extract(?, '$')
        AND generation <= json_extract(?, '$')
      ORDER BY generation ASC LIMIT json_extract(?, '$')`,
    ["0", "50001", "100"],
    100,
    /SEARCH private_hot_updater_insights_source_events USING INTEGER PRIMARY KEY/,
  );
  expect(sourceRows).toHaveLength(100);
  const allRows = await measuredRead(
    `SELECT event_id FROM private_hot_updater_insights_source_events
      INDEXED BY private_hot_updater_insights_source_event_order_idx
      WHERE received_at_ms >= json_extract(?, '$')
        AND received_at_ms < json_extract(?, '$')
      ORDER BY received_at_ms DESC, event_id COLLATE BINARY DESC
      LIMIT json_extract(?, '$')`,
    ["0", "60000", "101"],
    101,
    /SEARCH private_hot_updater_insights_source_events USING (?:COVERING )?INDEX private_hot_updater_insights_source_event_order_idx/,
  );
  expect(allRows).toHaveLength(101);
  const installationRows = await measuredRead(
    `SELECT event_id FROM private_hot_updater_insights_installation_events
      INDEXED BY private_hot_updater_insights_installation_event_order_idx
      WHERE install_id = json_extract(?, '$')
        AND received_at_ms >= json_extract(?, '$')
        AND received_at_ms < json_extract(?, '$')
      ORDER BY received_at_ms DESC, event_id COLLATE BINARY DESC
      LIMIT json_extract(?, '$')`,
    [JSON.stringify("install-50001"), "0", "60000", "101"],
    2,
    /SEARCH private_hot_updater_insights_installation_events USING (?:COVERING )?INDEX private_hot_updater_insights_installation_event_order_idx/,
  );
  expect(installationRows).toHaveLength(1);
  const bundleRows = await measuredRead(
    `SELECT event_id FROM private_hot_updater_insights_bundle_events
      INDEXED BY private_hot_updater_insights_bundle_event_order_idx
      WHERE bundle_id = json_extract(?, '$')
        AND received_at_ms >= json_extract(?, '$')
        AND received_at_ms < json_extract(?, '$')
      ORDER BY received_at_ms DESC, event_id COLLATE BINARY DESC
      LIMIT json_extract(?, '$')`,
    [JSON.stringify("to-bundle"), "0", "60000", "101"],
    101,
    /SEARCH private_hot_updater_insights_bundle_events USING (?:COVERING )?INDEX private_hot_updater_insights_bundle_event_order_idx/,
  );
  expect(bundleRows).toHaveLength(101);
  const liveRows = await measuredRead(
    `SELECT install_key, event_id
      FROM private_hot_updater_insights_live_installations
      ORDER BY install_key COLLATE BINARY ASC LIMIT json_extract(?, '$')`,
    ["101"],
    101,
    /SCAN private_hot_updater_insights_live_installations USING INDEX sqlite_autoindex_private_hot_updater_insights_live_installations_1/,
  );
  expect(liveRows).toHaveLength(101);
  const exactRows = await measuredRead(
    `SELECT event_id FROM private_hot_updater_insights_live_installations
      WHERE install_key = json_extract(?, '$') COLLATE BINARY LIMIT 1`,
    [JSON.stringify("1".padStart(64, "0"))],
    1,
    /SEARCH private_hot_updater_insights_live_installations USING INDEX sqlite_autoindex_private_hot_updater_insights_live_installations_1/,
  );
  expect(exactRows).toHaveLength(1);
  const selectedIds = allRows
    .slice(0, 100)
    .map((row) => (row as { event_id: string }).event_id);
  const rawRows = await measuredRead(
    `SELECT id FROM bundle_events
      WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(selectedIds)],
    300,
    /SEARCH bundle_events USING (?:COVERING )?INDEX sqlite_autoindex_bundle_events_1/,
  );
  expect(rawRows).toHaveLength(100);
});

const resetD1Schema = async (): Promise<void> => {
  await env.DB.prepare(`
    DROP TABLE IF EXISTS private_hot_updater_insights_live_installations;
    DROP TABLE IF EXISTS private_hot_updater_insights_installation_events;
    DROP TABLE IF EXISTS private_hot_updater_insights_bundle_events;
    DROP TABLE IF EXISTS private_hot_updater_insights_source_events;
    DROP TABLE IF EXISTS private_hot_updater_insights_source_state;
    DROP TABLE IF EXISTS bundle_patches;
    DROP TABLE IF EXISTS release_catalogs;
    DROP TABLE IF EXISTS releases;
    DROP TABLE IF EXISTS bundle_events;
    DROP TABLE IF EXISTS api_keys;
    DROP TABLE IF EXISTS channels;
    DROP TABLE IF EXISTS bundles;
    DROP TABLE IF EXISTS private_hot_updater_settings;
  `).run();
};

const executor: D1Executor = {
  async query(sql, params) {
    const result = await env.DB.prepare(sql)
      .bind(...params)
      .all();
    return result.results;
  },
  async batch(statements: readonly D1Statement[]) {
    const results = await env.DB.batch(
      statements.map(({ sql, params }) => env.DB.prepare(sql).bind(...params)),
    );
    return results.map(({ results }) => results ?? []);
  },
};
