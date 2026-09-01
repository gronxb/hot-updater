import {
  INSIGHTS_EVENT_MAX_BYTES,
  getCanonicalInsightsJsonByteLength,
} from "@hot-updater/plugin-core/internal";
import { env } from "cloudflare:test";
import { expect, inject, it } from "vitest";

import { createBundleEventRowFixture } from "../../../../packages/test-utils/src/databaseTestFixtures";
import type { D1Executor, D1Statement } from "../../src/d1Implementation";
import {
  createD1InsightsEventInsert,
  createD1InsightsSourceTools,
  d1InsightsInstallKey,
} from "../../src/d1InsightsSource";

declare module "vitest" {
  export interface ProvidedContext {
    d1Migrations: readonly {
      readonly name: string;
      readonly sql: string;
    }[];
  }
}

it("ships the core create and Insights migrations", () => {
  expect(inject("d1Migrations").map(({ name }) => name)).toEqual([
    "0001_hot-updater_1.0.0.sql",
    "0002_hot-updater_insights-v2.sql",
    "0003_hot-updater_insights-jobs.sql",
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

it("rejects a noncanonical legacy event ID without changing the raw row", async () => {
  const [createMigration, insightsMigration] = inject("d1Migrations");
  await resetD1Schema();
  await env.DB.prepare(createMigration!.sql).run();
  const invalid = {
    ...createBundleEventRowFixture("903", 100),
    id: "EVENT-903",
  };
  const columns = Object.keys(invalid);
  await env.DB.prepare(
    `INSERT INTO bundle_events (${columns.join(",")}) VALUES (${columns
      .map(() => "?")
      .join(",")})`,
  )
    .bind(...Object.values(invalid))
    .run();
  await env.DB.prepare(insightsMigration!.sql).run();

  let rawMaterialized = false;
  const measured: D1Executor = {
    async query(sql, params) {
      if (
        /FROM bundle_events WHERE id IN \(SELECT value FROM json_each/i.test(
          sql,
        )
      ) {
        rawMaterialized = true;
      }
      return executor.query(sql, params);
    },
    batch: executor.batch,
  };
  await expect(
    createD1InsightsSourceTools(measured).backfillStep(1),
  ).rejects.toThrow();
  expect(rawMaterialized).toBe(false);
  await expect(
    env.DB.prepare(
      "SELECT status FROM private_hot_updater_insights_source_state WHERE id = 1",
    ).first<string>("status"),
  ).resolves.toBe("failed");
  await expect(
    env.DB.prepare(
      "SELECT count(*) count FROM private_hot_updater_insights_source_events",
    ).first<number>("count"),
  ).resolves.toBe(0);
  await expect(
    env.DB.prepare("SELECT * FROM bundle_events WHERE id = ?")
      .bind(invalid.id)
      .first(),
  ).resolves.toMatchObject({ ...invalid, insights_row_bytes: null });
});

it("rejects an oversized legacy event without changing the raw row", async () => {
  const [createMigration, insightsMigration] = inject("d1Migrations");
  await resetD1Schema();
  await env.DB.prepare(createMigration!.sql).run();
  const largeValue = "€".repeat(900);
  const invalid = {
    ...createBundleEventRowFixture("904", 100),
    install_id: largeValue,
    user_id: largeValue,
    username: largeValue,
    from_bundle_id: largeValue,
    from_release_id: largeValue,
    to_bundle_id: largeValue,
    to_release_id: largeValue,
    app_version: largeValue,
  };
  expect(getCanonicalInsightsJsonByteLength(invalid)).toBeGreaterThan(
    INSIGHTS_EVENT_MAX_BYTES,
  );
  const columns = Object.keys(invalid);
  await env.DB.prepare(
    `INSERT INTO bundle_events (${columns.join(",")}) VALUES (${columns
      .map(() => "?")
      .join(",")})`,
  )
    .bind(...Object.values(invalid))
    .run();
  await env.DB.prepare(insightsMigration!.sql).run();

  let oversizedRawMaterialized = false;
  const oversizedMeasured: D1Executor = {
    async query(sql, params) {
      if (
        /FROM bundle_events WHERE id IN \(SELECT value FROM json_each/i.test(
          sql,
        )
      ) {
        oversizedRawMaterialized = true;
      }
      return executor.query(sql, params);
    },
    batch: executor.batch,
  };
  await expect(
    createD1InsightsSourceTools(oversizedMeasured).backfillStep(1),
  ).rejects.toThrow();
  expect(oversizedRawMaterialized).toBe(false);
  await expect(
    env.DB.prepare(
      `SELECT install_id, user_id, username, from_bundle_id, from_release_id,
        to_bundle_id, to_release_id, app_version,
        insights_write_version, insights_install_key,
        insights_row_bytes FROM bundle_events WHERE id = ?`,
    )
      .bind(invalid.id)
      .first(),
  ).resolves.toEqual({
    install_id: invalid.install_id,
    user_id: invalid.user_id,
    username: invalid.username,
    from_bundle_id: invalid.from_bundle_id,
    from_release_id: invalid.from_release_id,
    to_bundle_id: invalid.to_bundle_id,
    to_release_id: invalid.to_release_id,
    app_version: invalid.app_version,
    insights_write_version: null,
    insights_install_key: null,
    insights_row_bytes: null,
  });
  await expect(
    env.DB.prepare(
      "SELECT count(*) count FROM private_hot_updater_insights_source_events",
    ).first<number>("count"),
  ).resolves.toBe(0);
  await expect(
    env.DB.prepare(
      "SELECT status FROM private_hot_updater_insights_source_state WHERE id = 1",
    ).first<string>("status"),
  ).resolves.toBe("failed");
});

it("durably poisons an installation-key collision during backfill", async () => {
  const [createMigration, insightsMigration] = inject("d1Migrations");
  await resetD1Schema();
  await env.DB.prepare(createMigration!.sql).run();
  const event = createBundleEventRowFixture("907", 100);
  const columns = Object.keys(event);
  await env.DB.prepare(
    `INSERT INTO bundle_events (${columns.join(",")}) VALUES (${columns
      .map(() => "?")
      .join(",")})`,
  )
    .bind(...Object.values(event))
    .run();
  await env.DB.prepare(insightsMigration!.sql).run();

  const installKey = await d1InsightsInstallKey(event.install_id);
  await env.DB.prepare(
    `INSERT INTO private_hot_updater_insights_live_installations (
      install_key, install_id, event_id, received_at_ms, row_bytes
    ) VALUES (?, 'different-installation', ?, ?, 1)`,
  )
    .bind(installKey, event.id, event.received_at_ms)
    .run();
  await env.DB.prepare(
    `INSERT INTO private_hot_updater_insights_installation_aliases (
      install_key, install_id, alias_kind, alias_value, folded_value,
      first_generation
    ) VALUES (?, 'different-installation', 'installId',
      'different-installation', 'different-installation', 1)`,
  )
    .bind(installKey)
    .run();
  await env.DB.prepare(
    `INSERT INTO private_hot_updater_insights_installation_versions (
      install_key, generation, install_id, event_id, received_at_ms, row_bytes
    ) VALUES (?, 1, 'different-installation', ?, ?, 1)`,
  )
    .bind(installKey, event.id, event.received_at_ms)
    .run();

  const source = createD1InsightsSourceTools(executor);
  await expect(source.backfillStep(1)).rejects.toThrow(/poison/i);
  const failedState = {
    status: "failed",
    generation: 0,
    backfill_after_received_at_ms: null,
    backfill_after_id: null,
    source_rows: 0,
    raw_rows: 1,
  };
  const readState = () =>
    env.DB.prepare(
      `SELECT status, generation, backfill_after_received_at_ms,
        backfill_after_id,
        (SELECT count(*) FROM private_hot_updater_insights_source_events)
          AS source_rows,
        (SELECT count(*) FROM bundle_events) AS raw_rows
      FROM private_hot_updater_insights_source_state WHERE id = 1`,
    ).first();
  await expect(readState()).resolves.toEqual(failedState);
  await expect(source.backfillStep(1)).rejects.toThrow(/poison/i);

  await expect(source.recoverFailedPreparation()).rejects.toThrow(/poison/i);
  await expect(readState()).resolves.toEqual(failedState);
  await env.DB.prepare(
    "DELETE FROM private_hot_updater_insights_live_installations",
  ).run();
  await expect(source.recoverFailedPreparation()).rejects.toThrow(/poison/i);
  await expect(readState()).resolves.toEqual(failedState);
  await env.DB.prepare(
    "DELETE FROM private_hot_updater_insights_installation_aliases",
  ).run();
  await expect(source.recoverFailedPreparation()).rejects.toThrow(/poison/i);
  await expect(readState()).resolves.toEqual(failedState);
  await env.DB.prepare(
    "DELETE FROM private_hot_updater_insights_installation_versions",
  ).run();
  await env.DB.prepare(
    `INSERT INTO private_hot_updater_insights_installation_aliases (
      install_key, install_id, alias_kind, alias_value, folded_value,
      first_generation
    ) VALUES (?, ?, 'installId', ?, 'wrong-fold', 1)`,
  )
    .bind(installKey, event.install_id, event.install_id)
    .run();
  await expect(source.recoverFailedPreparation()).rejects.toThrow(/poison/i);
  await expect(readState()).resolves.toEqual(failedState);
  await env.DB.prepare(
    `UPDATE private_hot_updater_insights_installation_aliases
    SET folded_value = ? WHERE install_key = ?`,
  )
    .bind(event.install_id.toLowerCase(), installKey)
    .run();

  await expect(source.recoverFailedPreparation()).resolves.toEqual({
    recovered: true,
  });
  await expect(source.backfillStep(1)).resolves.toEqual({
    ready: false,
    processed: 1,
  });
  await expect(source.backfillStep(1)).resolves.toEqual({
    ready: true,
    processed: 0,
  });
  const generation = await source.capture();
  await expect(
    source.readPage({ sourceGeneration: generation, limit: 100 }),
  ).resolves.toEqual([{ generation: 1, event }]);
});

it("revalidates a repaired poison row and resumes the exact checkpoint", async () => {
  const [createMigration, insightsMigration] = inject("d1Migrations");
  await resetD1Schema();
  await env.DB.prepare(createMigration!.sql).run();
  const repaired = createBundleEventRowFixture("908", 100);
  const largeValue = "€".repeat(900);
  const poisoned = {
    ...repaired,
    install_id: largeValue,
    user_id: largeValue,
    username: largeValue,
    from_bundle_id: largeValue,
    from_release_id: largeValue,
    to_bundle_id: largeValue,
    to_release_id: largeValue,
    app_version: largeValue,
  };
  const columns = Object.keys(poisoned);
  await env.DB.prepare(
    `INSERT INTO bundle_events (${columns.join(",")}) VALUES (${columns
      .map(() => "?")
      .join(",")})`,
  )
    .bind(...Object.values(poisoned))
    .run();
  await env.DB.prepare(insightsMigration!.sql).run();
  const source = createD1InsightsSourceTools(executor);
  await expect(source.backfillStep(1)).rejects.toThrow();
  const failedState = await env.DB.prepare(
    `SELECT generation, backfill_upper_received_at_ms, backfill_upper_id,
      backfill_after_received_at_ms, backfill_after_id
    FROM private_hot_updater_insights_source_state WHERE id = 1`,
  ).first();

  const duringOutage = await createD1InsightsEventInsert(
    createBundleEventRowFixture("909", 200),
  );
  await expect(
    executor.query(duringOutage.sql, duringOutage.params),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare(
      `SELECT
        (SELECT count(*) FROM bundle_events) AS raw_rows,
        (SELECT count(*) FROM private_hot_updater_insights_pending_events)
          AS pending_rows`,
    ).first(),
  ).resolves.toEqual({ raw_rows: 1, pending_rows: 0 });

  await env.DB.prepare(
    `UPDATE bundle_events SET install_id = ?, user_id = ?, username = ?,
      from_bundle_id = ?, from_release_id = ?, to_bundle_id = ?,
      to_release_id = ?, app_version = ? WHERE id = ?`,
  )
    .bind(
      repaired.install_id,
      repaired.user_id,
      repaired.username,
      repaired.from_bundle_id,
      repaired.from_release_id,
      repaired.to_bundle_id,
      repaired.to_release_id,
      repaired.app_version,
      repaired.id,
    )
    .run();
  const reopened = createD1InsightsSourceTools(executor);
  await expect(reopened.recoverFailedPreparation()).resolves.toEqual({
    recovered: true,
  });
  await expect(
    env.DB.prepare(
      `SELECT generation, backfill_upper_received_at_ms, backfill_upper_id,
        backfill_after_received_at_ms, backfill_after_id
      FROM private_hot_updater_insights_source_state WHERE id = 1`,
    ).first(),
  ).resolves.toEqual(failedState);
  await expect(reopened.backfillStep(1)).resolves.toEqual({
    ready: false,
    processed: 1,
  });
  await expect(reopened.backfillStep(1)).resolves.toEqual({
    ready: true,
    processed: 0,
  });
  const generation = await reopened.capture();
  await expect(
    reopened.readPage({ sourceGeneration: generation, limit: 100 }),
  ).resolves.toEqual([{ generation: 1, event: repaired }]);
  await expect(
    env.DB.prepare("SELECT * FROM bundle_events WHERE id = ?")
      .bind(repaired.id)
      .first(),
  ).resolves.toMatchObject({ ...repaired, insights_write_version: null });
});

it("leaves the legacy checkpoint retryable after an operational pointer read failure", async () => {
  const [createMigration, insightsMigration] = inject("d1Migrations");
  await resetD1Schema();
  await env.DB.prepare(createMigration!.sql).run();
  const legacy = createBundleEventRowFixture("907", 100);
  const columns = Object.keys(legacy);
  await env.DB.prepare(
    `INSERT INTO bundle_events (${columns.join(",")}) VALUES (${columns
      .map(() => "?")
      .join(",")})`,
  )
    .bind(...Object.values(legacy))
    .run();
  await env.DB.prepare(insightsMigration!.sql).run();

  const transient = new Error("temporary D1 read failure");
  let failed = false;
  const flaky: D1Executor = {
    async query(sql, params) {
      if (!failed && /FROM bundle_events WHERE id IN/i.test(sql)) {
        failed = true;
        throw transient;
      }
      return executor.query(sql, params);
    },
    batch: executor.batch,
  };
  await expect(createD1InsightsSourceTools(flaky).backfillStep(1)).rejects.toBe(
    transient,
  );
  await expect(
    env.DB.prepare(
      `SELECT status, generation, backfill_after_id
      FROM private_hot_updater_insights_source_state WHERE id = 1`,
    ).first(),
  ).resolves.toEqual({
    status: "preparing",
    generation: 0,
    backfill_after_id: null,
  });
  await expect(
    createD1InsightsSourceTools(executor).backfillStep(1),
  ).resolves.toEqual({ processed: 1, ready: false });
});

it("accepts v2 appends during legacy preparation and drains them after the fixed prefix", async () => {
  const [createMigration, insightsMigration] = inject("d1Migrations");
  await resetD1Schema();
  await env.DB.prepare(createMigration!.sql).run();
  const legacy = createBundleEventRowFixture("905", 100);
  const columns = Object.keys(legacy);
  await env.DB.prepare(
    `INSERT INTO bundle_events (${columns.join(",")}) VALUES (${columns
      .map(() => "?")
      .join(",")})`,
  )
    .bind(...Object.values(legacy))
    .run();
  await env.DB.prepare(insightsMigration!.sql).run();

  const appended = {
    ...createBundleEventRowFixture("906", 50),
    provider_extension: { nested: ["preserved", 2, true] },
  };
  const statement = await createD1InsightsEventInsert(appended);
  await executor.query(statement.sql, statement.params);
  await expect(
    env.DB.prepare(
      "SELECT count(*) count FROM private_hot_updater_insights_pending_events",
    ).first<number>("count"),
  ).resolves.toBe(1);

  const source = createD1InsightsSourceTools(executor);
  await expect(source.backfillStep(1)).resolves.toEqual({
    processed: 1,
    ready: false,
  });
  await expect(source.backfillStep(1)).resolves.toEqual({
    processed: 1,
    ready: true,
  });
  const generation = await source.capture();
  await expect(
    source.readPage({ sourceGeneration: generation, limit: 100 }),
  ).resolves.toEqual([
    { generation: 1, event: legacy },
    { generation: 2, event: appended },
  ]);
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
      printf('00000000-0000-7000-8000-%012d', n),
      'UPDATE_APPLIED', 'install-' || n, 'from-bundle', 'to-bundle',
      'ios', '1.0.0', 'production', '0', 'appVersion', n
    FROM source
  `).run();
  await env.DB.prepare(
    "UPDATE bundle_events SET install_id = ? WHERE received_at_ms = 25001",
  )
    .bind("x".repeat(21_000))
    .run();
  await env.DB.prepare(insightsMigration!.sql).run();

  const plan = await env.DB.prepare(`
    EXPLAIN QUERY PLAN
    SELECT id FROM bundle_events INDEXED BY bundle_events_insights_backfill_idx
    WHERE insights_write_version IS NULL
      AND (received_at_ms, id COLLATE BINARY) <= (50001, ? COLLATE BINARY)
    ORDER BY received_at_ms ASC, id COLLATE BINARY ASC LIMIT 2
  `)
    .bind("00000000-0000-7000-8000-000000050001")
    .all<{ detail: string }>();
  expect(plan.results.map(({ detail }) => detail).join("\n")).toMatch(
    /SEARCH bundle_events USING (?:COVERING )?INDEX bundle_events_insights_backfill_idx/,
  );
  expect(plan.results.map(({ detail }) => detail).join("\n")).not.toMatch(
    /SCAN bundle_events|USE TEMP B-TREE/,
  );

  let queryCount = 0;
  let batchStatements = 0;
  let maximumBatchStatements = 0;
  let totalRowsRead = 0;
  let totalRowsWritten = 0;
  let maximumRowsRead = 0;
  let maximumStorageBytes = 0;
  let legacySeekSql = "";
  const observe = (meta: Record<string, unknown>) => {
    if (typeof meta.rows_read === "number") {
      totalRowsRead += meta.rows_read;
      maximumRowsRead = Math.max(maximumRowsRead, meta.rows_read);
    }
    if (typeof meta.rows_written === "number") {
      totalRowsWritten += meta.rows_written;
    }
    if (typeof meta.size_after === "number") {
      maximumStorageBytes = Math.max(maximumStorageBytes, meta.size_after);
    }
  };
  const measured: D1Executor = {
    async query(sql, params) {
      queryCount += 1;
      const result = await env.DB.prepare(sql)
        .bind(...params)
        .all();
      observe(result.meta as unknown as Record<string, unknown>);
      if (
        /FROM bundle_events INDEXED BY bundle_events_insights_backfill_idx/i.test(
          sql,
        )
      ) {
        legacySeekSql = sql;
      }
      return result.results;
    },
    async batch(statements) {
      batchStatements += statements.length;
      maximumBatchStatements = Math.max(
        maximumBatchStatements,
        statements.length,
      );
      const results = await env.DB.batch(
        statements.map(({ sql, params }) =>
          env.DB.prepare(sql).bind(...params),
        ),
      );
      for (const result of results) {
        observe(result.meta as unknown as Record<string, unknown>);
      }
      return results.map(({ results }) => results ?? []);
    },
  };
  const startedAt = performance.now();
  let invocations = 0;
  let processed = 0;
  let repaired = false;
  let source = createD1InsightsSourceTools(measured);
  const first = await source.backfillStep(100);
  invocations += 1;
  processed += first.processed;
  const appended = createBundleEventRowFixture("800001", 75_000);
  const pending = await createD1InsightsEventInsert(appended);
  await measured.query(pending.sql, pending.params);
  source = createD1InsightsSourceTools(measured);
  for (;;) {
    try {
      const result = await source.backfillStep(100);
      invocations += 1;
      processed += result.processed;
      if (result.ready) break;
      source = createD1InsightsSourceTools(measured);
    } catch {
      expect(repaired).toBe(false);
      repaired = true;
      const failed = await env.DB.prepare(
        `SELECT status, generation, backfill_after_received_at_ms,
          backfill_after_id FROM private_hot_updater_insights_source_state
        WHERE id = 1`,
      ).first();
      expect(failed).toMatchObject({ status: "failed" });
      await env.DB.prepare(
        `UPDATE bundle_events SET install_id = 'install-25001'
        WHERE received_at_ms = 25001`,
      ).run();
      source = createD1InsightsSourceTools(measured);
      await expect(source.recoverFailedPreparation()).resolves.toEqual({
        recovered: true,
      });
      await expect(
        env.DB.prepare(
          `SELECT generation, backfill_after_received_at_ms,
            backfill_after_id FROM private_hot_updater_insights_source_state
          WHERE id = 1`,
        ).first(),
      ).resolves.toEqual({
        generation: (failed as { generation: number }).generation,
        backfill_after_received_at_ms: (
          failed as { backfill_after_received_at_ms: number | null }
        ).backfill_after_received_at_ms,
        backfill_after_id: (failed as { backfill_after_id: string | null })
          .backfill_after_id,
      });
    }
  }
  const elapsedMs = performance.now() - startedAt;
  expect(repaired).toBe(true);
  expect(processed).toBe(50_002);
  expect(invocations).toBeLessThan(1_000);
  expect(maximumBatchStatements).toBeLessThanOrEqual(10);
  expect(queryCount + batchStatements).toBeLessThan(10_000);
  expect(totalRowsRead).toBeGreaterThan(0);
  expect(totalRowsWritten).toBeGreaterThan(0);
  expect(maximumRowsRead).toBeLessThan(1_000);
  expect(maximumStorageBytes).toBeGreaterThan(0);
  expect(elapsedMs).toBeLessThan(120_000);
  expect(legacySeekSql).toMatch(
    /SELECT id, received_at_ms, length\(CAST\(json_object\(/i,
  );
  await expect(
    env.DB.prepare(
      `SELECT status, generation,
        (SELECT count(*) FROM private_hot_updater_insights_source_events)
          AS source_rows,
        (SELECT count(*) FROM private_hot_updater_insights_pending_events)
          AS pending_rows
      FROM private_hot_updater_insights_source_state WHERE id = 1`,
    ).first(),
  ).resolves.toEqual({
    status: "ready",
    generation: 50_002,
    source_rows: 50_002,
    pending_rows: 0,
  });

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
    [JSON.stringify(await d1InsightsInstallKey("install-1"))],
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
}, 120_000);

const resetD1Schema = async (): Promise<void> => {
  await env.DB.prepare(`
    DROP TABLE IF EXISTS private_hot_updater_insights_installation_versions;
    DROP TABLE IF EXISTS private_hot_updater_insights_installation_aliases;
    DROP TABLE IF EXISTS private_hot_updater_insights_live_installations;
    DROP TABLE IF EXISTS private_hot_updater_insights_installation_events;
    DROP TABLE IF EXISTS private_hot_updater_insights_bundle_events;
    DROP TABLE IF EXISTS private_hot_updater_insights_source_events;
    DROP TABLE IF EXISTS private_hot_updater_insights_pending_events;
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
