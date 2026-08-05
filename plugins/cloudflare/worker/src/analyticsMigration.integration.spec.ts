import {
  AnalyticsSchemaCompatibilityError,
  InvalidBundleEventPersistenceRowError,
} from "@hot-updater/analytics/provider";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { migrateD1WorkerAnalytics } from "../../src/cloudflareWorkerDatabase";
import {
  createCoreSettings,
  createLegacyV1AnalyticsSchema,
  createLegacyV2AnalyticsSchema,
  insertLegacyTransition,
  readAnalyticsMarker,
  resetAnalyticsDatabase,
} from "./analyticsMigration.testFixtures";

beforeEach(resetAnalyticsDatabase);

describe("D1 Analytics schema migration", () => {
  it("creates schema 2 on a core 0.36 database and is ready on rerun", async () => {
    await createCoreSettings("0.36.0");

    await expect(migrateD1WorkerAnalytics(env.DB)).resolves.toEqual({
      kind: "created-v2",
    });
    await expect(migrateD1WorkerAnalytics(env.DB)).resolves.toEqual({
      kind: "ready",
    });
    await expect(readAnalyticsMarker()).resolves.toBe("2");
  });

  it("migrates exact legacy 0.37 rows without data loss", async () => {
    await createCoreSettings("0.37.0");
    await createLegacyV1AnalyticsSchema();
    await insertLegacyTransition();

    await expect(migrateD1WorkerAnalytics(env.DB)).resolves.toEqual({
      kind: "migrated-v1-v2",
    });
    await expect(
      env.DB.prepare(
        "SELECT type, from_bundle_id FROM bundle_events WHERE id = 'legacy-event'",
      ).first(),
    ).resolves.toEqual({
      from_bundle_id: "bundle-a",
      type: "UPDATE_APPLIED",
    });
    await expect(readAnalyticsMarker()).resolves.toBe("2");
  });

  it("adopts the exact immutable 0.38 shape without rewriting rows", async () => {
    await createCoreSettings("0.38.0");
    await createLegacyV2AnalyticsSchema();
    await insertLegacyTransition();

    await expect(migrateD1WorkerAnalytics(env.DB)).resolves.toEqual({
      kind: "adopted-v2",
    });
    await expect(
      env.DB.prepare(
        "SELECT id FROM bundle_events WHERE id = 'legacy-event'",
      ).first(),
    ).resolves.toEqual({ id: "legacy-event" });
    await expect(readAnalyticsMarker()).resolves.toBe("2");
  });

  it("fails closed on a future component version", async () => {
    await createCoreSettings("0.38.0", "3");
    await createLegacyV2AnalyticsSchema();

    await expect(migrateD1WorkerAnalytics(env.DB)).rejects.toBeInstanceOf(
      AnalyticsSchemaCompatibilityError,
    );
    await expect(readAnalyticsMarker()).resolves.toBe("3");
  });

  it("fails closed on physical schema drift", async () => {
    await createCoreSettings("0.38.0", "2");
    await createLegacyV2AnalyticsSchema();
    await env.DB.exec("ALTER TABLE bundle_events ADD COLUMN unexpected TEXT");

    await expect(migrateD1WorkerAnalytics(env.DB)).rejects.toBeInstanceOf(
      AnalyticsSchemaCompatibilityError,
    );
    await expect(readAnalyticsMarker()).resolves.toBe("2");
  });

  it.each([
    ["appversion", { fingerprint: "fingerprint", appVersion: "appversion" }],
    ["finger print", { fingerprint: "finger print", appVersion: "appVersion" }],
  ] as const)(
    "rejects a v2 CHECK with the noncanonical %s literal",
    async (_literal, literals) => {
      await createCoreSettings("0.38.0");
      await createLegacyV2AnalyticsSchema(literals);

      await expect(migrateD1WorkerAnalytics(env.DB)).rejects.toBeInstanceOf(
        AnalyticsSchemaCompatibilityError,
      );
      await expect(readAnalyticsMarker()).resolves.toBeNull();
    },
  );

  it("rejects adoption when bundle events has an extra trigger", async () => {
    await createCoreSettings("0.38.0");
    await createLegacyV2AnalyticsSchema();
    await env.DB.prepare(`
      CREATE TRIGGER discard_bundle_events
      AFTER INSERT ON bundle_events
      BEGIN
        DELETE FROM bundle_events WHERE id = NEW.id;
      END
    `).run();

    await expect(migrateD1WorkerAnalytics(env.DB)).rejects.toBeInstanceOf(
      AnalyticsSchemaCompatibilityError,
    );
    await expect(readAnalyticsMarker()).resolves.toBeNull();
  });

  it("revalidates persisted rows when marker 2 is already present", async () => {
    await createCoreSettings("0.36.0");
    await migrateD1WorkerAnalytics(env.DB);
    await env.DB.prepare(`
      INSERT INTO bundle_events (
        id, type, install_id, user_id, username, from_bundle_id, to_bundle_id,
        platform, app_version, channel, cohort, update_strategy,
        fingerprint_hash, sdk_version, received_at_ms
      ) VALUES (
        'invalid-platform', 'UNCHANGED', 'install-1', NULL, NULL, NULL,
        'bundle-a', 'windows', '1.0.0', 'production', 'stable', NULL,
        NULL, NULL, 100
      )
    `).run();

    await expect(migrateD1WorkerAnalytics(env.DB)).rejects.toBeInstanceOf(
      InvalidBundleEventPersistenceRowError,
    );
    await expect(readAnalyticsMarker()).resolves.toBe("2");
  });

  it("rolls back a failed schema batch before the marker", async () => {
    await createCoreSettings("0.36.0");
    await env.DB.prepare(
      "CREATE TABLE analytics_index_conflict (id TEXT)",
    ).run();
    await env.DB.prepare(
      "CREATE INDEX bundle_events_installed_bundle_idx ON analytics_index_conflict(id)",
    ).run();

    await expect(migrateD1WorkerAnalytics(env.DB)).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bundle_events'",
      ).first(),
    ).resolves.toBeNull();
    await expect(readAnalyticsMarker()).resolves.toBeNull();
  });

  it("recovers when schema creation succeeds before the marker write", async () => {
    await env.DB.prepare(`
      CREATE TABLE private_hot_updater_settings (
        key TEXT PRIMARY KEY NOT NULL CHECK (key != 'schema.analytics'),
        value TEXT NOT NULL
      )
    `).run();
    await env.DB.prepare(`
      INSERT INTO private_hot_updater_settings (key, value)
      VALUES ('version', '0.36.0')
    `).run();

    await expect(migrateD1WorkerAnalytics(env.DB)).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bundle_events'",
      ).first(),
    ).resolves.toEqual({ name: "bundle_events" });

    await env.DB.prepare("DROP TABLE private_hot_updater_settings").run();
    await createCoreSettings("0.36.0");

    await expect(migrateD1WorkerAnalytics(env.DB)).resolves.toEqual({
      kind: "adopted-v2",
    });
    await expect(readAnalyticsMarker()).resolves.toBe("2");
  });
});
