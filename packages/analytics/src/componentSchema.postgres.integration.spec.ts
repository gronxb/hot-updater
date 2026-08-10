import { PGlite } from "@electric-sql/pglite";
import {
  getUniversalComponentSchemaMarkerKey,
  type UniversalComponentDataAdapter,
} from "@hot-updater/plugin-core";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPostgresUniversalComponentDataAdapter } from "../../../plugins/postgres/src/postgresUniversalComponentData";
import type { Database as PostgresDatabase } from "../../../plugins/postgres/src/types";
import { analyticsComponentSchema } from "./componentSchema";
import type { BundleEventPersistenceRow } from "./provider/persistence";
import { createUniversalComponentAnalyticsPersistence } from "./provider/universalComponentPersistence";

const settingsTable = "private_hot_updater_settings";
const markerKey = getUniversalComponentSchemaMarkerKey(
  analyticsComponentSchema,
);

const indexes = `
  CREATE INDEX bundle_events_installed_bundle_idx
    ON bundle_events(type, to_bundle_id, received_at_ms, id);
  CREATE INDEX bundle_events_recovered_bundle_idx
    ON bundle_events(type, from_bundle_id, received_at_ms, id);
  CREATE INDEX bundle_events_install_idx
    ON bundle_events(install_id, received_at_ms, id);
  CREATE INDEX bundle_events_user_id_idx
    ON bundle_events(user_id, received_at_ms, id);
  CREATE INDEX bundle_events_username_idx
    ON bundle_events(username, received_at_ms, id);
  CREATE INDEX bundle_events_cohort_idx
    ON bundle_events(cohort, type, received_at_ms, id);
  CREATE INDEX bundle_events_received_at_idx
    ON bundle_events(received_at_ms, id);
`;

const columns = `
  id uuid PRIMARY KEY NOT NULL,
  type text NOT NULL,
  install_id text NOT NULL,
  user_id text,
  username text,
  from_bundle_id uuid,
  to_bundle_id uuid NOT NULL,
  platform text NOT NULL,
  app_version text NOT NULL,
  channel text NOT NULL,
  cohort text NOT NULL,
  update_strategy text,
  fingerprint_hash text,
  sdk_version text,
  received_at_ms double precision NOT NULL
`;

const appliedRow: BundleEventPersistenceRow = {
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprint_hash: null,
  from_bundle_id: "00000000-0000-0000-0000-000000000001",
  id: "00000000-0000-0000-0000-000000000101",
  install_id: "install-1",
  platform: "ios",
  received_at_ms: 1_000,
  sdk_version: null,
  to_bundle_id: "00000000-0000-0000-0000-000000000002",
  type: "UPDATE_APPLIED",
  update_strategy: "appVersion",
  user_id: null,
  username: null,
};

const recoveredRow: BundleEventPersistenceRow = {
  ...appliedRow,
  from_bundle_id: "00000000-0000-0000-0000-000000000003",
  id: "00000000-0000-0000-0000-000000000102",
  install_id: "install-2",
  type: "RECOVERED",
  update_strategy: "fingerprint",
};

const unchangedRow: BundleEventPersistenceRow = {
  ...appliedRow,
  from_bundle_id: null,
  id: "00000000-0000-0000-0000-000000000103",
  install_id: "install-3",
  received_at_ms: 2_000,
  type: "UNCHANGED",
  update_strategy: null,
};

describe("Analytics component schema with the generic Postgres adapter", () => {
  let client: PGlite | undefined;
  let database: Kysely<PostgresDatabase> | undefined;
  let adapter: UniversalComponentDataAdapter | undefined;

  const getClient = (): PGlite => {
    if (client === undefined) throw new TypeError("PGlite is not initialized");
    return client;
  };

  const getAdapter = (): UniversalComponentDataAdapter => {
    if (adapter === undefined) {
      throw new TypeError("Postgres adapter is not initialized");
    }
    return adapter;
  };

  const migrate = async () => {
    const migration = getAdapter().migrate;
    if (migration === undefined) {
      throw new TypeError("Postgres component migration is unavailable");
    }
    return migration(analyticsComponentSchema);
  };

  const setSetting = async (key: string, value: string): Promise<void> => {
    await getClient().query(
      `INSERT INTO ${settingsTable} (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  };

  const setLegacyVersion = (version: string): Promise<void> =>
    setSetting("version", version);

  const marker = async (): Promise<string | null> => {
    const result = await getClient().query<{ readonly value: string }>(
      `SELECT value FROM ${settingsTable} WHERE key = $1`,
      [markerKey],
    );
    return result.rows[0]?.value ?? null;
  };

  const createV1Catalog = async (): Promise<void> => {
    await getClient().exec(`
      CREATE TABLE bundle_events (
        ${columns
          .replace("from_bundle_id uuid,", "from_bundle_id uuid NOT NULL,")
          .replace("update_strategy text,", "update_strategy text NOT NULL,")},
        CONSTRAINT bundle_events_type_check
          CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED')),
        CONSTRAINT bundle_events_update_strategy_check
          CHECK (update_strategy IN ('fingerprint', 'appVersion'))
      );
      ${indexes}
    `);
  };

  const createV2Catalog = async (): Promise<void> => {
    await getClient().exec(`
      CREATE TABLE bundle_events (
        ${columns},
        CONSTRAINT bundle_events_type_v038_check
          CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')),
        CONSTRAINT bundle_events_update_strategy_v038_check
          CHECK (
            update_strategy IS NULL OR
            update_strategy IN ('fingerprint', 'appVersion')
          ),
        CONSTRAINT bundle_events_shape_v038_check CHECK (
          (
            type IN ('UPDATE_APPLIED', 'RECOVERED') AND
            from_bundle_id IS NOT NULL AND
            update_strategy IS NOT NULL
          ) OR (
            type = 'UNCHANGED' AND
            from_bundle_id IS NULL AND
            update_strategy IS NULL
          )
        )
      );
      ${indexes}
    `);
  };

  const insertRow = async (row: BundleEventPersistenceRow): Promise<void> => {
    await getClient().query(
      `INSERT INTO bundle_events (
         id, type, install_id, user_id, username, from_bundle_id,
         to_bundle_id, platform, app_version, channel, cohort,
         update_strategy, fingerprint_hash, sdk_version, received_at_ms
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15
       )`,
      [
        row.id,
        row.type,
        row.install_id,
        row.user_id,
        row.username,
        row.from_bundle_id,
        row.to_bundle_id,
        row.platform,
        row.app_version,
        row.channel,
        row.cohort,
        row.update_strategy,
        row.fingerprint_hash,
        row.sdk_version,
        row.received_at_ms,
      ],
    );
  };

  beforeEach(async () => {
    client = new PGlite();
    database = new Kysely<PostgresDatabase>({
      dialect: new PGliteDialect(client),
    });
    adapter = createPostgresUniversalComponentDataAdapter(database);
    await client.exec(`
      CREATE TABLE ${settingsTable} (
        key text PRIMARY KEY NOT NULL,
        value text NOT NULL
      );
      INSERT INTO ${settingsTable} (key, value)
      VALUES ('sentinel', 'keep');
    `);
  });

  afterEach(async () => {
    await database?.destroy();
    adapter = undefined;
    database = undefined;
    client = undefined;
  });

  it("migrates the released 0.37 v1 catalog to v2 without replacing data or security", async () => {
    await setLegacyVersion("0.37.0");
    await createV1Catalog();
    await getClient().exec(`
      ALTER TABLE bundle_events ENABLE ROW LEVEL SECURITY;
      CREATE POLICY existing_analytics_policy ON bundle_events
        FOR SELECT USING (true);
    `);
    await insertRow(appliedRow);

    await expect(migrate()).resolves.toEqual({ changed: true, version: "2" });

    await expect(marker()).resolves.toBe("2");
    await expect(
      getAdapter().bind(analyticsComponentSchema).assertReady(),
    ).resolves.toBeUndefined();
    const rows = await getClient().query<BundleEventPersistenceRow>(
      "SELECT * FROM bundle_events ORDER BY id",
    );
    expect(rows.rows).toEqual([appliedRow]);
    const nullable = await getClient().query<{
      readonly column_name: string;
      readonly is_nullable: string;
    }>(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'bundle_events'
        AND column_name IN ('from_bundle_id', 'update_strategy')
      ORDER BY column_name
    `);
    expect(nullable.rows).toEqual([
      { column_name: "from_bundle_id", is_nullable: "YES" },
      { column_name: "update_strategy", is_nullable: "YES" },
    ]);
    const security = await getClient().query<{
      readonly policyname: string;
      readonly relrowsecurity: boolean;
    }>(`
      SELECT policy.policyname, relation.relrowsecurity
      FROM pg_policies AS policy
      JOIN pg_class AS relation ON relation.relname = policy.tablename
      WHERE policy.tablename = 'bundle_events'
    `);
    expect(security.rows).toEqual([
      { policyname: "existing_analytics_policy", relrowsecurity: true },
    ]);
  });

  it("adopts an unmarked v2 catalog without replacing its rows", async () => {
    await setLegacyVersion("0.38.0");
    await createV2Catalog();
    await insertRow(unchangedRow);

    await expect(migrate()).resolves.toEqual({ changed: true, version: "2" });

    await expect(marker()).resolves.toBe("2");
    const rows = await getClient().query<BundleEventPersistenceRow>(
      "SELECT * FROM bundle_events ORDER BY id",
    );
    expect(rows.rows).toEqual([unchangedRow]);
  });

  it("repairs a v1 marker after the physical schema reached latest and reruns idempotently", async () => {
    await setLegacyVersion("0.37.0");
    await createV2Catalog();
    await insertRow(unchangedRow);
    await setSetting(markerKey, "1");

    await expect(migrate()).resolves.toEqual({ changed: true, version: "2" });
    await expect(migrate()).resolves.toEqual({ changed: false, version: "2" });

    await expect(marker()).resolves.toBe("2");
    const rows = await getClient().query<BundleEventPersistenceRow>(
      "SELECT * FROM bundle_events ORDER BY id",
    );
    expect(rows.rows).toEqual([unchangedRow]);
  });

  it("rejects validation-only corruption before adopting an unmarked v2 catalog", async () => {
    await setLegacyVersion("0.38.0");
    await createV2Catalog();
    await insertRow({ ...unchangedRow, platform: "ios" });
    await getClient().exec(
      "UPDATE bundle_events SET platform = 'web' WHERE id = '00000000-0000-0000-0000-000000000103'",
    );

    await expect(migrate()).rejects.toThrow(
      "Invalid row for component table: bundle_events@2",
    );

    await expect(marker()).resolves.toBeNull();
    const rows = await getClient().query<{ readonly platform: string }>(
      "SELECT platform FROM bundle_events",
    );
    expect(rows.rows).toEqual([{ platform: "web" }]);
  });

  it("validates past the first 1,000 stored rows before mutating v1", async () => {
    await setLegacyVersion("0.37.0");
    await createV1Catalog();
    await getClient().exec(`
      INSERT INTO bundle_events (
        id, type, install_id, from_bundle_id, to_bundle_id, platform,
        app_version, channel, cohort, update_strategy, received_at_ms
      )
      SELECT
        ('00000000-0000-0000-0000-' || lpad(value::text, 12, '0'))::uuid,
        'UPDATE_APPLIED',
        'install-' || value,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000002'::uuid,
        CASE WHEN value = 1001 THEN 'web' ELSE 'ios' END,
        '1.0.0',
        'production',
        'default',
        'appVersion',
        value
      FROM generate_series(1, 1001) AS value;
    `);

    await expect(migrate()).rejects.toThrow(
      "Invalid row for component table: bundle_events@1",
    );

    await expect(marker()).resolves.toBeNull();
    const nullable = await getClient().query<{
      readonly is_nullable: string;
    }>(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'bundle_events'
        AND column_name = 'from_bundle_id'
    `);
    expect(nullable.rows).toEqual([{ is_nullable: "NO" }]);
  });

  it("rolls back the v1 transition when the marker write is interrupted, then converges idempotently", async () => {
    await setLegacyVersion("0.37.0");
    await createV1Catalog();
    await insertRow(appliedRow);
    await setSetting(markerKey, "1");
    await getClient().exec(`
      ALTER TABLE ${settingsTable}
      ADD CONSTRAINT reject_analytics_v2 CHECK (value <> '2');
    `);

    await expect(migrate()).rejects.toBeDefined();

    await expect(marker()).resolves.toBe("1");
    const rolledBackColumn = await getClient().query<{
      readonly is_nullable: string;
    }>(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'bundle_events'
        AND column_name = 'from_bundle_id'
    `);
    expect(rolledBackColumn.rows).toEqual([{ is_nullable: "NO" }]);

    await getClient().exec(`
      ALTER TABLE ${settingsTable}
      DROP CONSTRAINT reject_analytics_v2;
    `);
    await expect(migrate()).resolves.toEqual({ changed: true, version: "2" });
    await expect(migrate()).resolves.toEqual({ changed: false, version: "2" });
    const rows = await getClient().query<BundleEventPersistenceRow>(
      "SELECT * FROM bundle_events ORDER BY id",
    );
    expect(rows.rows).toEqual([appliedRow]);
  });

  it("appends and scans Analytics rows through the provider-neutral source", async () => {
    await setLegacyVersion("0.36.0");
    await expect(migrate()).resolves.toEqual({ changed: true, version: "2" });
    const persistence = createUniversalComponentAnalyticsPersistence(
      getAdapter().bind(analyticsComponentSchema),
    );

    await persistence.append(recoveredRow);
    await persistence.append(unchangedRow);
    await persistence.append(appliedRow);

    await expect(
      persistence.scan({ beforeReceivedAtMs: 2_000, limit: 10 }),
    ).resolves.toEqual([appliedRow, recoveredRow]);
    await expect(
      persistence.scan({
        after: {
          id: appliedRow.id,
          receivedAtMs: appliedRow.received_at_ms,
        },
        beforeReceivedAtMs: 2_001,
        limit: 1,
      }),
    ).resolves.toEqual([recoveredRow]);
  });
});
