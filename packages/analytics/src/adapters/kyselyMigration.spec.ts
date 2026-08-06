import { sql, type Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  AnalyticsSchemaCompatibilityError,
  AnalyticsSchemaNotReadyError,
  type AnalyticsMigrationResult,
} from "../provider/migration";
import type { BundleEventPersistenceRow } from "../provider/persistence";
import {
  InvalidBundleEventPersistenceRowError,
  parseBundleEventPersistenceRow,
} from "../provider/rowParser";
import {
  createKyselyAnalyticsMigrationStore,
  migrateKyselyAnalyticsSchema,
} from "./kyselyMigration";
import {
  ANALYTICS_SQL_COLUMNS,
  createAnalyticsV2Statements,
} from "./kyselyMigrationSql";
import {
  createMigrationTestDatabase as createDatabase,
  createV1MigrationTestSchema as createV1,
  destroyMigrationTestDatabases,
  executeMigrationTestStatements as executeStatements,
  storedAnalyticsMarker as storedMarker,
} from "./kyselyMigrationTestFixtures";

afterEach(async () => {
  await destroyMigrationTestDatabases();
});

async function createV2Database(
  settings: readonly (readonly [string, string])[],
): Promise<Kysely<object>> {
  const database = await createDatabase(settings);
  await executeStatements(database, createAnalyticsV2Statements("postgresql"));
  return database;
}

function migrate(database: Kysely<object>): Promise<AnalyticsMigrationResult> {
  return migrateKyselyAnalyticsSchema({
    db: database,
    dialect: "postgresql",
  });
}

describe("migrateKyselyAnalyticsSchema", () => {
  it("creates a fresh v2 schema without a Core foreign key", async () => {
    const database = await createDatabase([["version", "0.36.0"]]);

    const result = await migrate(database);

    expect(result).toEqual({ kind: "created-v2" });
    await expect(storedMarker(database)).resolves.toBe("2");
    const foreignKeys = await sql<unknown>`
      select conname from pg_constraint
      where conrelid = 'bundle_events'::regclass and contype = 'f'
    `.execute(database);
    expect(foreignKeys.rows).toEqual([]);
  });

  it("preserves v1 rows while upgrading exact legacy 0.37", async () => {
    const database = await createDatabase([["version", "0.37.0"]]);
    await createV1(database);
    const row: BundleEventPersistenceRow = {
      id: "00000000-0000-0000-0000-000000000011",
      type: "UPDATE_APPLIED",
      install_id: "install-1",
      user_id: "user-1",
      username: "Ada",
      from_bundle_id: "00000000-0000-0000-0000-000000000001",
      to_bundle_id: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
      app_version: "1.0.0",
      channel: "production",
      cohort: "cohort-1",
      update_strategy: "appVersion",
      fingerprint_hash: "fingerprint-1",
      sdk_version: "0.20.0",
      received_at_ms: 1,
    };
    await sql
      .raw(`
      insert into bundle_events (${ANALYTICS_SQL_COLUMNS.join(", ")}) values (
        '00000000-0000-0000-0000-000000000011', 'UPDATE_APPLIED',
        'install-1', 'user-1', 'Ada',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        'ios', '1.0.0', 'production', 'cohort-1',
        'appVersion', 'fingerprint-1', '0.20.0', 1
      )
    `)
      .execute(database);

    const result = await migrate(database);
    const rows = await sql<unknown>`
      select * from ${sql.table("bundle_events")}
    `.execute(database);

    expect(result).toEqual({ kind: "migrated-v1-v2" });
    expect(rows.rows.map(parseBundleEventPersistenceRow)).toEqual([row]);
    await expect(storedMarker(database)).resolves.toBe("2");
  });

  it.each([
    { component: undefined, legacy: "0.36.0" },
    { component: undefined, legacy: "0.38.0" },
    { component: "1", legacy: "0.37.0" },
  ])(
    "adopts exact v2 state after an interrupted marker write %#",
    async ({ component, legacy }) => {
      const settings: (readonly [string, string])[] = [["version", legacy]];
      if (component !== undefined)
        settings.push(["schema.analytics", component]);
      const database = await createV2Database(settings);

      const result = await migrate(database);

      expect(result).toEqual({ kind: "adopted-v2" });
      await expect(storedMarker(database)).resolves.toBe("2");
    },
  );

  it("returns ready without rewriting an exact current schema", async () => {
    const database = await createV2Database([
      ["version", "0.38.0"],
      ["schema.analytics", "2"],
    ]);

    const result = await migrate(database);

    expect(result).toEqual({ kind: "ready" });
  });

  it("rejects schema drift without writing the component marker", async () => {
    const database = await createV2Database([["version", "0.38.0"]]);
    await sql.raw("drop index bundle_events_received_at_idx").execute(database);

    const migration = migrate(database);

    await expect(migration).rejects.toBeInstanceOf(
      AnalyticsSchemaCompatibilityError,
    );
    await expect(storedMarker(database)).resolves.toBeNull();
  });

  it("rejects future legacy evidence even when the physical schema is v2", async () => {
    const database = await createV2Database([["version", "0.39.0"]]);

    await expect(migrate(database)).rejects.toBeInstanceOf(
      AnalyticsSchemaCompatibilityError,
    );
    await expect(storedMarker(database)).resolves.toBeNull();
  });

  it("rejects a future component marker", async () => {
    const database = await createV2Database([
      ["version", "0.38.0"],
      ["schema.analytics", "3"],
    ]);

    await expect(migrate(database)).rejects.toBeInstanceOf(
      AnalyticsSchemaCompatibilityError,
    );
  });

  it("rejects a corrupt component marker value", async () => {
    const database = await createV2Database([["version", "0.38.0"]]);
    await sql
      .raw(`
      alter table private_hot_updater_settings
      alter column value type bytea using convert_to(value, 'UTF8')
    `)
      .execute(database);
    await sql
      .raw(`
      insert into private_hot_updater_settings (key, value)
      values ('schema.analytics', decode('ff', 'hex'))
    `)
      .execute(database);

    await expect(migrate(database)).rejects.toThrow(
      "Invalid Analytics schema setting: schema.analytics",
    );
  });

  it("validates every stored row before writing the marker", async () => {
    const database = await createV2Database([["version", "0.38.0"]]);
    await sql
      .raw(`
      insert into bundle_events (${ANALYTICS_SQL_COLUMNS.join(", ")}) values (
        '00000000-0000-0000-0000-000000000011', 'UPDATE_APPLIED',
        'install-1', null, null,
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
        'windows', '1.0.0', 'production', 'cohort-1',
        'appVersion', null, null, 1
      )
    `)
      .execute(database);

    await expect(migrate(database)).rejects.toBeInstanceOf(
      InvalidBundleEventPersistenceRowError,
    );
    await expect(storedMarker(database)).resolves.toBeNull();
  });
});

describe("createKyselyAnalyticsMigrationStore", () => {
  it("fails readiness validation for exact v2 without the component marker", async () => {
    const database = await createV2Database([["version", "0.38.0"]]);
    const store = createKyselyAnalyticsMigrationStore({
      db: database,
      dialect: "postgresql",
    });

    await expect(store.assertReady()).rejects.toBeInstanceOf(
      AnalyticsSchemaNotReadyError,
    );
  });
});
