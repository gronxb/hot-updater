import {
  AnalyticsSchemaNotReadyError,
  type BundleEventPersistenceRow,
} from "@hot-updater/analytics/provider";
import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";

import { migrateD1WorkerAnalytics } from "../../src/cloudflareWorkerDatabase";
import { createD1AnalyticsPersistence } from "../../src/d1AnalyticsPersistence";
import {
  createCoreSettings,
  createLegacyV2AnalyticsSchema,
  readAnalyticsMarker,
  resetAnalyticsDatabase,
} from "./analyticsMigration.testFixtures";

const row = (id: string, receivedAtMs: number): BundleEventPersistenceRow => ({
  id,
  type: "UNCHANGED",
  install_id: `install-${id}`,
  user_id: null,
  username: null,
  from_bundle_id: null,
  to_bundle_id: "bundle-a",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "stable",
  update_strategy: null,
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

const createPersistence = () =>
  createD1AnalyticsPersistence({
    async query(sql, params) {
      const result = await env.DB.prepare(sql)
        .bind(...params)
        .all();
      return result.results;
    },
  });

beforeEach(resetAnalyticsDatabase);

it("scans D1 rows by the exclusive ordered cursor and cutoff", async () => {
  await createCoreSettings("0.36.0");
  await migrateD1WorkerAnalytics(env.DB);
  const persistence = createPersistence();
  await persistence.append(row("d", 300));
  await persistence.append(row("b", 100));
  await persistence.append(row("a", 100));
  await persistence.append(row("c", 200));

  const rows = await persistence.scan({
    beforeReceivedAtMs: 300,
    after: { receivedAtMs: 100, id: "a" },
    limit: 2,
  });

  expect(rows.map(({ id }) => id)).toEqual(["b", "c"]);
});

it("does not auto-adopt an exact unmarked v2 schema", async () => {
  await createCoreSettings("0.38.0");
  await createLegacyV2AnalyticsSchema();
  const persistence = createPersistence();

  await expect(
    persistence.scan({ beforeReceivedAtMs: 1, limit: 1 }),
  ).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
  await expect(readAnalyticsMarker()).resolves.toBeNull();
});

it("rejects a future marker after the persistence instance was ready", async () => {
  await createCoreSettings("0.36.0");
  await migrateD1WorkerAnalytics(env.DB);
  const persistence = createPersistence();
  await persistence.append(row("ready", 1));
  await env.DB.prepare(`
    UPDATE private_hot_updater_settings
    SET value = '3'
    WHERE key = 'schema.analytics'
  `).run();

  await expect(persistence.append(row("future", 2))).rejects.toBeInstanceOf(
    AnalyticsSchemaNotReadyError,
  );
  await expect(readAnalyticsMarker()).resolves.toBe("3");
});

it("rejects a deleted marker after the persistence instance was ready", async () => {
  await createCoreSettings("0.36.0");
  await migrateD1WorkerAnalytics(env.DB);
  const persistence = createPersistence();
  await persistence.scan({ beforeReceivedAtMs: 1, limit: 1 });
  await env.DB.prepare(`
    DELETE FROM private_hot_updater_settings
    WHERE key = 'schema.analytics'
  `).run();

  await expect(
    persistence.scan({ beforeReceivedAtMs: 1, limit: 1 }),
  ).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
  await expect(readAnalyticsMarker()).resolves.toBeNull();
});

it("rejects physical schema drift during initial readiness", async () => {
  await createCoreSettings("0.38.0", "2");
  await createLegacyV2AnalyticsSchema();
  await env.DB.exec("ALTER TABLE bundle_events ADD COLUMN unexpected TEXT");
  const persistence = createPersistence();

  await expect(
    persistence.scan({ beforeReceivedAtMs: 1, limit: 1 }),
  ).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
  await expect(readAnalyticsMarker()).resolves.toBe("2");
});

it("rejects malformed persisted rows during initial readiness", async () => {
  await createCoreSettings("0.38.0", "2");
  await createLegacyV2AnalyticsSchema();
  await env.DB.prepare(`
    INSERT INTO bundle_events (
      id, type, install_id, user_id, username, from_bundle_id, to_bundle_id,
      platform, app_version, channel, cohort, update_strategy,
      fingerprint_hash, sdk_version, received_at_ms
    ) VALUES (
      'malformed', 'UNCHANGED', 'install-malformed', NULL, NULL, NULL,
      'bundle-a', 'web', '1.0.0', 'production', 'stable', NULL,
      NULL, NULL, 1
    )
  `).run();
  const persistence = createPersistence();

  await expect(persistence.append(row("blocked", 2))).rejects.toBeInstanceOf(
    AnalyticsSchemaNotReadyError,
  );
  await expect(readAnalyticsMarker()).resolves.toBe("2");
  await expect(
    env.DB.prepare("SELECT COUNT(*) AS count FROM bundle_events").first<number>(
      "count",
    ),
  ).resolves.toBe(1);
});

it("rejects an extra bundle event trigger even with marker 2", async () => {
  await createCoreSettings("0.38.0", "2");
  await createLegacyV2AnalyticsSchema();
  await env.DB.prepare(`
    CREATE TRIGGER discard_bundle_events
    AFTER INSERT ON bundle_events
    BEGIN
      DELETE FROM bundle_events WHERE id = NEW.id;
    END
  `).run();
  const persistence = createPersistence();

  await expect(persistence.append(row("discarded", 1))).rejects.toBeInstanceOf(
    AnalyticsSchemaNotReadyError,
  );
});
