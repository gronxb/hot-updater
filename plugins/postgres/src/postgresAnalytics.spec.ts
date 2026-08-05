import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import type { BundleEventPersistenceRow } from "@hot-updater/analytics/provider";
import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it } from "vitest";

import { postgres } from "./postgres";
import { createPostgresAnalyticsPersistence } from "./postgresAnalyticsPersistence";

type AnalyticsTestDatabase = {
  readonly bundle_events: BundleEventPersistenceRow;
};

const migrationPath = path.resolve("plugins/postgres/sql/analytics.sql");
const packageRequire = createRequire(import.meta.url);
const databases: PGlite[] = [];
const kyselyInstances: Kysely<AnalyticsTestDatabase>[] = [];

const createDatabase = (): {
  readonly database: PGlite;
  readonly kysely: Kysely<AnalyticsTestDatabase>;
} => {
  const database = new PGlite();
  const kysely = new Kysely<AnalyticsTestDatabase>({
    dialect: new PGliteDialect(database),
  });
  databases.push(database);
  kyselyInstances.push(kysely);
  return { database, kysely };
};

const migrate = async (database: PGlite): Promise<void> => {
  await database.exec(await fs.readFile(migrationPath, "utf8"));
};

const event = (
  id: string,
  receivedAtMs: number,
  type: BundleEventPersistenceRow["type"] = "UPDATE_APPLIED",
): BundleEventPersistenceRow =>
  type === "UNCHANGED"
    ? {
        id,
        type,
        install_id: `install-${id}`,
        user_id: null,
        username: null,
        from_bundle_id: null,
        to_bundle_id: "00000000-0000-0000-0000-000000000020",
        platform: "ios",
        app_version: "1.0.0",
        channel: "production",
        cohort: "default",
        update_strategy: null,
        fingerprint_hash: null,
        sdk_version: null,
        received_at_ms: receivedAtMs,
      }
    : {
        id,
        type,
        install_id: `install-${id}`,
        user_id: null,
        username: null,
        from_bundle_id: "00000000-0000-0000-0000-000000000010",
        to_bundle_id: "00000000-0000-0000-0000-000000000020",
        platform: "ios",
        app_version: "1.0.0",
        channel: "production",
        cohort: "default",
        update_strategy: "appVersion",
        fingerprint_hash: null,
        sdk_version: null,
        received_at_ms: receivedAtMs,
      };

afterEach(async () => {
  for (const kysely of kyselyInstances.splice(0)) await kysely.destroy();
  for (const database of databases.splice(0)) await database.close();
});

describe("Postgres Analytics persistence", () => {
  it("exports the packaged Analytics migration artifact", async () => {
    const resolved = packageRequire.resolve(
      "@hot-updater/postgres/sql/analytics.sql",
    );

    expect(path.basename(resolved)).toBe("analytics.sql");
    await expect(fs.readFile(resolved, "utf8")).resolves.toContain(
      "schema.analytics",
    );
  });

  it("advertises the explicit Analytics provider capability", async () => {
    const database = new PGlite();
    databases.push(database);
    const plugin = postgres({ dialect: new PGliteDialect(database) });

    expect(
      getCapabilityContributions(plugin).map(({ token }) => token.id),
    ).toContain("hot-updater.analytics.provider@1");
    await plugin.onUnmount?.();
  });

  it("rejects writes until the Analytics component marker is ready", async () => {
    const { database, kysely } = createDatabase();
    await database.exec(`
      create table private_hot_updater_settings (
        key text primary key not null,
        value text not null
      );
      insert into private_hot_updater_settings (key, value)
      values ('version', '0.36.0');
    `);
    const persistence = createPostgresAnalyticsPersistence(kysely);

    await expect(
      persistence.append(event("00000000-0000-0000-0000-000000000100", 10)),
    ).rejects.toMatchObject({
      inspection: { componentVersion: null },
      name: "AnalyticsSchemaNotReadyError",
    });
    const tables = await database.query<{ readonly name: string | null }>(
      "select to_regclass('public.bundle_events')::text as name",
    );
    expect(tables.rows).toEqual([{ name: null }]);

    await migrate(database);
    await persistence.append(event("00000000-0000-0000-0000-000000000100", 10));
    const stored = await database.query<{ readonly id: string }>(
      "select id from bundle_events",
    );
    expect(stored.rows).toEqual([
      { id: "00000000-0000-0000-0000-000000000100" },
    ]);
  });

  it("rejects runtime access when marker 2 contradicts PostgreSQL catalog state", async () => {
    const { database, kysely } = createDatabase();
    await database.exec(`
      create table private_hot_updater_settings (
        key text primary key not null,
        value text not null
      );
      insert into private_hot_updater_settings (key, value)
      values ('version', '0.36.0');
    `);
    await migrate(database);
    await database.exec(`
      update pg_index set indisready = false
      where indexrelid = 'bundle_events_received_at_idx'::regclass;
    `);
    const persistence = createPostgresAnalyticsPersistence(kysely);

    await expect(
      persistence.append(event("00000000-0000-0000-0000-000000000100", 10)),
    ).rejects.toMatchObject({
      inspection: {
        componentVersion: "2",
        fingerprint: "analytics-schema-drift",
      },
      name: "AnalyticsSchemaNotReadyError",
    });
    const rows = await database.query<{ readonly count: number }>(
      "select count(*)::integer as count from bundle_events",
    );
    expect(rows.rows).toEqual([{ count: 0 }]);
  });

  it("appends rows and scans an exclusive ordered cursor window", async () => {
    const { database, kysely } = createDatabase();
    await database.exec(`
      create table private_hot_updater_settings (
        key text primary key not null,
        value text not null
      );
      insert into private_hot_updater_settings (key, value)
      values ('version', '0.36.0');
    `);
    await migrate(database);
    const persistence = createPostgresAnalyticsPersistence(kysely);
    const firstId = "00000000-0000-0000-0000-000000000101";
    const secondId = "00000000-0000-0000-0000-000000000102";
    const thirdId = "00000000-0000-0000-0000-000000000103";
    const upperBoundId = "00000000-0000-0000-0000-000000000104";
    await persistence.append(event(thirdId, 20));
    await persistence.append(event(secondId, 10, "UNCHANGED"));
    await persistence.append(event(firstId, 10));
    await persistence.append(event(upperBoundId, 30));
    await expect(persistence.append(event(firstId, 25))).rejects.toThrow();

    const rows = await persistence.scan({
      after: { id: firstId, receivedAtMs: 10 },
      beforeReceivedAtMs: 30,
      limit: 2,
    });

    expect(rows.map(({ id }) => id)).toEqual([secondId, thirdId]);
  });
});
