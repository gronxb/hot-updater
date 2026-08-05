import { afterEach, describe, expect, it } from "vitest";

import {
  closeDatabases,
  createDatabase,
  expectMigrationFailure,
  initializeSettings,
  initializeV1,
  initializeV2,
  migrate,
  readSettings,
} from "./postgresAnalyticsMigration.testFixtures.js";

afterEach(closeDatabases);

describe("Postgres Analytics schema migration", () => {
  it.each(["0.21.0", "0.29.0", "0.31.0", "0.36.0"])(
    "creates schema 2 from known pre-Analytics Core version %s",
    async (legacyVersion) => {
      const database = createDatabase();
      await initializeSettings(database, legacyVersion);

      await migrate(database);

      expect(await readSettings(database)).toContainEqual({
        key: "schema.analytics",
        value: "2",
      });
    },
  );

  it.each(["0.13.0", "0.18.0", "0.30.0"])(
    "rejects legacy version %s outside the Core compatibility contract",
    async (legacyVersion) => {
      const database = createDatabase();
      await initializeSettings(database, legacyVersion);

      await expectMigrationFailure(database);

      expect(await readSettings(database)).not.toContainEqual({
        key: "schema.analytics",
        value: "2",
      });
    },
  );

  it("creates schema 2, writes its marker, and reruns without changing state", async () => {
    const database = createDatabase();
    await initializeSettings(database, "0.36.0");

    await migrate(database);
    const firstSettings = await readSettings(database);
    await migrate(database);

    expect(await readSettings(database)).toEqual(firstSettings);
    expect(firstSettings).toEqual([
      { key: "schema.analytics", value: "2" },
      { key: "sentinel", value: "keep" },
      { key: "version", value: "0.36.0" },
    ]);
    const table = await database.query<{ readonly relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid = 'bundle_events'::regclass",
    );
    expect(table.rows).toEqual([{ relrowsecurity: false }]);
  });

  it("migrates exact schema 1 while preserving rows, RLS, and legacy settings", async () => {
    const database = createDatabase();
    await initializeSettings(database, "0.37.0");
    await initializeV1(database);

    await migrate(database);

    const rows = await database.query<{
      readonly install_id: string;
      readonly type: string;
    }>("select install_id, type from bundle_events");
    expect(rows.rows).toEqual([
      { install_id: "install-1", type: "UPDATE_APPLIED" },
    ]);
    const state = await database.query<{
      readonly column_name: string;
      readonly is_nullable: string;
    }>(`
      select column_name, is_nullable
      from information_schema.columns
      where table_name = 'bundle_events'
        and column_name in ('from_bundle_id', 'update_strategy')
      order by column_name
    `);
    expect(state.rows).toEqual([
      { column_name: "from_bundle_id", is_nullable: "YES" },
      { column_name: "update_strategy", is_nullable: "YES" },
    ]);
    expect(await readSettings(database)).toContainEqual({
      key: "version",
      value: "0.37.0",
    });
    const security = await database.query<{
      readonly policyname: string;
      readonly relrowsecurity: boolean;
    }>(`
      select policy.policyname, relation.relrowsecurity
      from pg_policies as policy
      join pg_class as relation on relation.relname = policy.tablename
      where policy.tablename = 'bundle_events'
    `);
    expect(security.rows).toEqual([
      { policyname: "existing_analytics_policy", relrowsecurity: true },
    ]);
  });

  it("adopts exact schema 2 without replacing its table", async () => {
    const database = createDatabase();
    await initializeSettings(database, "0.38.0");
    await initializeV2(database);
    await database.exec(`
      insert into bundle_events (
        id, type, install_id, to_bundle_id, platform, app_version, channel,
        cohort, received_at_ms
      ) values (
        '00000000-0000-0000-0000-000000000102', 'UNCHANGED', 'install-2',
        '00000000-0000-0000-0000-000000000002', 'ios', '1.0.0',
        'production', 'default', 2000
      );
    `);

    await migrate(database);

    expect(
      (
        await database.query<{ readonly id: string }>(
          "select id from bundle_events",
        )
      ).rows,
    ).toEqual([{ id: "00000000-0000-0000-0000-000000000102" }]);
    expect(await readSettings(database)).toContainEqual({
      key: "schema.analytics",
      value: "2",
    });
  });

  it("finishes an interrupted schema 1 marker after schema 2 is ready", async () => {
    const database = createDatabase();
    await initializeSettings(database, "0.37.0");
    await initializeV2(database);
    await database.exec(`
      insert into private_hot_updater_settings (key, value)
      values ('schema.analytics', '1');
    `);

    await migrate(database);

    expect(await readSettings(database)).toContainEqual({
      key: "schema.analytics",
      value: "2",
    });
  });

  it("rejects physical drift and future markers without mutation", async () => {
    const drifted = createDatabase();
    await initializeSettings(drifted, "0.38.0");
    await initializeV2(drifted);
    await drifted.exec("drop index bundle_events_cohort_idx");

    await expectMigrationFailure(drifted);

    expect(await readSettings(drifted)).not.toContainEqual({
      key: "schema.analytics",
      value: "2",
    });
    const future = createDatabase();
    await initializeSettings(future, "0.38.0");
    await initializeV2(future);
    await future.exec(
      "insert into private_hot_updater_settings (key, value) values ('schema.analytics', '3')",
    );
    await expectMigrationFailure(future);
    expect(await readSettings(future)).toContainEqual({
      key: "schema.analytics",
      value: "3",
    });
  });

  it("rejects an integer timestamp lookalike instead of adopting it as schema 2", async () => {
    const database = createDatabase();
    await initializeSettings(database, "0.38.0");
    await initializeV2(database, "integer");

    await expectMigrationFailure(database);

    expect(await readSettings(database)).not.toContainEqual({
      key: "schema.analytics",
      value: "2",
    });
  });

  it("rejects a future legacy version before creating Analytics storage", async () => {
    const database = createDatabase();
    await initializeSettings(database, "0.39.0");

    await expectMigrationFailure(database);

    const table = await database.query<{ readonly name: string | null }>(
      "select to_regclass('public.bundle_events')::text as name",
    );
    expect(table.rows).toEqual([{ name: null }]);
    expect(await readSettings(database)).toContainEqual({
      key: "version",
      value: "0.39.0",
    });
  });

  it("rolls back physical creation when the final marker write fails", async () => {
    const database = createDatabase();
    await initializeSettings(
      database,
      "0.36.0",
      ", constraint reject_analytics_marker check (key <> 'schema.analytics')",
    );

    await expectMigrationFailure(database);

    const table = await database.query<{ readonly name: string | null }>(
      "select to_regclass('public.bundle_events')::text as name",
    );
    expect(table.rows).toEqual([{ name: null }]);
  });
});
