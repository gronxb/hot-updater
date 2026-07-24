import { PGlite } from "@electric-sql/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { afterEach, describe, expect, it } from "vitest";

import { bundleEventsV037 } from "../schema/v0_37_0";
import { createKyselyMigrator } from "./fixedMigrator";
import {
  createCheckSql,
  createIndexSql,
  createTableStatement,
} from "./schema/sql";

interface SettingsDatabase {
  readonly private_hot_updater_settings: {
    readonly key: string;
    readonly value: string;
  };
}

type TestDatabase = {
  readonly database: PGlite;
  readonly kysely: Kysely<SettingsDatabase>;
};

const databases: PGlite[] = [];
const kyselyInstances: Kysely<SettingsDatabase>[] = [];

const eventColumns = `
  id, type, install_id, user_id, username, from_bundle_id, to_bundle_id,
  platform, app_version, channel, cohort, update_strategy, fingerprint_hash,
  sdk_version, received_at_ms
`;

const createDatabase = (): TestDatabase => {
  const database = new PGlite();
  const kysely = new Kysely<SettingsDatabase>({
    dialect: new PGliteDialect(database),
  });
  databases.push(database);
  kyselyInstances.push(kysely);
  return { database, kysely };
};

const initializeV037 = async (database: PGlite): Promise<void> => {
  const statements = [
    createTableStatement(bundleEventsV037, "postgresql"),
    ...(bundleEventsV037.indexes ?? []).map((index) =>
      createIndexSql(bundleEventsV037, index, "postgresql"),
    ),
    ...(bundleEventsV037.checks ?? []).map((check) =>
      createCheckSql(bundleEventsV037, check),
    ),
    `create table private_hot_updater_settings (
      key varchar(255) primary key,
      value text not null
    )`,
    `insert into private_hot_updater_settings (key, value) values
      ('version', '0.37.0'),
      ('sentinel', 'keep')`,
    `insert into bundle_events (${eventColumns}) values (
      '00000000-0000-0000-0000-000000000101', 'UPDATE_APPLIED',
      'install-1', null, null,
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      'ios', '1.0.0', 'production', 'cohort-1', 'appVersion', null, null, 1000
    )`,
  ];
  await database.exec(
    statements.map((statement) => `${statement};`).join("\n"),
  );
};

const migrate = async ({ database, kysely }: TestDatabase): Promise<void> => {
  const result = await createKyselyMigrator({
    db: kysely,
    provider: "postgresql",
  }).migrateToLatest({ mode: "from-schema" });
  await result.execute();
  const version = await database.query<{ readonly value: string }>(
    "select value from private_hot_updater_settings where key = 'version'",
  );
  expect(version.rows).toEqual([{ value: "0.38.0" }]);
};

afterEach(async () => {
  for (const kysely of kyselyInstances.splice(0)) await kysely.destroy();
  for (const database of databases.splice(0)) await database.close();
});

describe("PostgreSQL v0.38 migration", () => {
  it("creates a fresh schema that accepts valid UNCHANGED rows", async () => {
    // Given
    const testDatabase = createDatabase();

    // When
    await migrate(testDatabase);
    await testDatabase.database.exec(`
      insert into bundle_events (${eventColumns}) values (
        '00000000-0000-0000-0000-000000000102', 'UNCHANGED',
        'install-2', null, null, null,
        '00000000-0000-0000-0000-000000000002',
        'ios', '1.0.0', 'production', 'cohort-2', null, null, null, 2000
      )
    `);

    // Then
    const rows = await testDatabase.database.query<{ readonly type: string }>(
      "select type from bundle_events",
    );
    expect(rows.rows).toEqual([{ type: "UNCHANGED" }]);
  });

  it("preserves v0.37 rows, settings, indexes, and installs new checks", async () => {
    // Given
    const testDatabase = createDatabase();
    await initializeV037(testDatabase.database);

    // When
    await migrate(testDatabase);

    // Then
    const events = await testDatabase.database.query<{
      readonly install_id: string;
      readonly type: string;
    }>("select type, install_id from bundle_events");
    expect(events.rows).toEqual([
      { install_id: "install-1", type: "UPDATE_APPLIED" },
    ]);
    const settings = await testDatabase.database.query<{
      readonly key: string;
      readonly value: string;
    }>("select key, value from private_hot_updater_settings order by key");
    expect(settings.rows).toEqual([
      { key: "sentinel", value: "keep" },
      { key: "version", value: "0.38.0" },
    ]);
    const indexes = await testDatabase.database.query(
      "select indexname from pg_indexes where tablename = 'bundle_events'",
    );
    expect(indexes.rows).toHaveLength(8);
    const checks = await testDatabase.database.query<{
      readonly conname: string;
    }>(
      "select conname from pg_constraint where conrelid = 'bundle_events'::regclass and contype = 'c' order by conname",
    );
    expect(checks.rows).toEqual([
      { conname: "bundle_events_shape_v038_check" },
      { conname: "bundle_events_type_v038_check" },
      { conname: "bundle_events_update_strategy_v038_check" },
    ]);
  });

  it("rolls back an interrupted constraint replacement and retries cleanly", async () => {
    // Given
    const testDatabase = createDatabase();
    await initializeV037(testDatabase.database);
    await testDatabase.database.exec(
      "alter table bundle_events add constraint bundle_events_type_v038_check check (true)",
    );
    const result = await createKyselyMigrator({
      db: testDatabase.kysely,
      provider: "postgresql",
    }).migrateToLatest({ mode: "from-schema" });

    // When
    await expect(result.execute()).rejects.toThrow();

    // Then
    const columns = await testDatabase.database.query<{
      readonly column_name: string;
      readonly is_nullable: string;
    }>(`
      select column_name, is_nullable
      from information_schema.columns
      where table_name = 'bundle_events'
        and column_name in ('from_bundle_id', 'update_strategy')
      order by column_name
    `);
    expect(columns.rows).toEqual([
      { column_name: "from_bundle_id", is_nullable: "NO" },
      { column_name: "update_strategy", is_nullable: "NO" },
    ]);
    await testDatabase.database.exec(
      "alter table bundle_events drop constraint bundle_events_type_v038_check",
    );
    await migrate(testDatabase);
  });
});
