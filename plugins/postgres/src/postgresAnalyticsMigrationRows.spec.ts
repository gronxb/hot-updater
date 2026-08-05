import { afterEach, describe, expect, it } from "vitest";

import {
  closeDatabases,
  createDatabase,
  expectMigrationFailure,
  initializeSettings,
  initializeV1,
  initializeV2,
  readSettings,
} from "./postgresAnalyticsMigration.testFixtures.js";

const invalidV2Rows: readonly {
  readonly assignment: string;
  readonly caseName: string;
}[] = [
  { assignment: "platform = 'web'", caseName: "unsupported platform" },
  { assignment: "install_id = ''", caseName: "empty required string" },
  { assignment: "user_id = ''", caseName: "empty optional string" },
  { assignment: "received_at_ms = -1", caseName: "negative timestamp" },
  { assignment: "received_at_ms = 1.5", caseName: "fractional timestamp" },
  {
    assignment: "received_at_ms = 9007199254740992",
    caseName: "unsafe integer timestamp",
  },
  {
    assignment: "received_at_ms = 'NaN'::double precision",
    caseName: "NaN timestamp",
  },
  {
    assignment: "received_at_ms = 'Infinity'::double precision",
    caseName: "infinite timestamp",
  },
];

const insertValidV2Row = async (
  database: ReturnType<typeof createDatabase>,
): Promise<void> => {
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
};

afterEach(closeDatabases);

describe("Postgres Analytics migration row validation", () => {
  it.each(invalidV2Rows)(
    "rejects $caseName before adopting schema 2",
    async ({ assignment }) => {
      const database = createDatabase();
      await initializeSettings(database, "0.38.0");
      await initializeV2(database);
      await insertValidV2Row(database);
      await database.exec(`update bundle_events set ${assignment}`);

      await expectMigrationFailure(database);

      expect(await readSettings(database)).not.toContainEqual({
        key: "schema.analytics",
        value: "2",
      });
      const rows = await database.query<{ readonly count: number }>(
        "select count(*)::integer as count from bundle_events",
      );
      expect(rows.rows).toEqual([{ count: 1 }]);
    },
  );

  it("rolls back the v1 schema mutation when a legacy row is invalid", async () => {
    const database = createDatabase();
    await initializeSettings(database, "0.37.0");
    await initializeV1(database);
    await database.exec("update bundle_events set platform = 'web'");

    await expectMigrationFailure(database);

    expect(await readSettings(database)).not.toContainEqual({
      key: "schema.analytics",
      value: "2",
    });
    const columns = await database.query<{
      readonly is_nullable: string;
    }>(`
      select is_nullable from information_schema.columns
      where table_name = 'bundle_events' and column_name = 'from_bundle_id'
    `);
    expect(columns.rows).toEqual([{ is_nullable: "NO" }]);
    const rows = await database.query<{ readonly platform: string }>(
      "select platform from bundle_events",
    );
    expect(rows.rows).toEqual([{ platform: "web" }]);
  });

  it("refuses a marked schema 2 whose persisted rows are invalid", async () => {
    const database = createDatabase();
    await initializeSettings(database, "0.36.0");
    await initializeV2(database);
    await database.exec(`
      insert into private_hot_updater_settings (key, value)
      values ('schema.analytics', '2')
    `);
    await insertValidV2Row(database);
    await database.exec("update bundle_events set platform = 'web'");

    await expectMigrationFailure(database);

    expect(await readSettings(database)).toContainEqual({
      key: "schema.analytics",
      value: "2",
    });
    const rows = await database.query<{ readonly platform: string }>(
      "select platform from bundle_events",
    );
    expect(rows.rows).toEqual([{ platform: "web" }]);
  });
});
