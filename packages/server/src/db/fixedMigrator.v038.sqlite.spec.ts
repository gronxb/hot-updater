import { DatabaseSync, type SqliteValue } from "node:sqlite";

import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { bundleEventsV037 } from "../schema/v0_37_0";
import { createKyselyMigrator } from "./fixedMigrator";
import { createIndexSql, createTableStatement } from "./schema/sql";

interface SettingsDatabase {
  readonly private_hot_updater_settings: {
    readonly key: string;
    readonly value: string;
  };
}

const databases: DatabaseSync[] = [];

const createKysely = (database: DatabaseSync): Kysely<SettingsDatabase> =>
  new Kysely<SettingsDatabase>({
    dialect: new SqliteDialect({
      database: {
        close: () => database.close(),
        prepare: (sqlText) => {
          const statement = database.prepare(sqlText);
          return {
            reader: statement.columns().length > 0,
            all: (parameters) =>
              statement.all(...(parameters as SqliteValue[])),
            run: (parameters) => {
              const result = statement.run(...(parameters as SqliteValue[]));
              return {
                changes: result.changes,
                lastInsertRowid: result.lastInsertRowid,
              };
            },
            iterate: (parameters) =>
              statement.iterate(...(parameters as SqliteValue[])),
          };
        },
      },
    }),
  });

const transitionValues = `
  'event-1', 'UPDATE_APPLIED', 'install-1', null, null,
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  'ios', '1.0.0', 'production', 'cohort-1', 'appVersion', null, null, 1000
`;

const eventColumns = `
  id, type, install_id, user_id, username, from_bundle_id, to_bundle_id,
  platform, app_version, channel, cohort, update_strategy, fingerprint_hash,
  sdk_version, received_at_ms
`;

const createV037Database = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(createTableStatement(bundleEventsV037, "sqlite"));
  for (const index of bundleEventsV037.indexes ?? []) {
    database.exec(createIndexSql(bundleEventsV037, index, "sqlite"));
  }
  database.exec(`
    create table private_hot_updater_settings (
      key text primary key,
      value text not null
    );
    insert into private_hot_updater_settings (key, value) values
      ('version', '0.37.0'),
      ('sentinel', 'keep');
    insert into bundle_events (${eventColumns}) values (${transitionValues});
  `);
  return database;
};

const migrateV037 = async (): Promise<DatabaseSync> => {
  const database = createV037Database();
  const kysely = createKysely(database);
  const migration = await createKyselyMigrator({
    db: kysely,
    provider: "sqlite",
  }).migrateToLatest({ mode: "from-schema" });
  await migration.execute();
  return database;
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("SQLite v0.38 migration", () => {
  it("preserves transition rows, settings, and bundle event indexes", async () => {
    // Given / When
    const database = await migrateV037();

    // Then
    expect(database.prepare("select * from bundle_events").all()).toHaveLength(
      1,
    );
    expect(
      database
        .prepare(
          "select key, value from private_hot_updater_settings order by key",
        )
        .all(),
    ).toEqual([
      { key: "sentinel", value: "keep" },
      { key: "version", value: "0.38.0" },
    ]);
    expect(
      database
        .prepare(
          "select name from pragma_index_list('bundle_events') order by name",
        )
        .all(),
    ).toHaveLength(8);
  });

  it("accepts an UNCHANGED row with null transition fields", async () => {
    // Given
    const database = await migrateV037();

    // When / Then
    expect(() =>
      database.exec(`
        insert into bundle_events (${eventColumns}) values (
          'event-2', 'UNCHANGED', 'install-2', null, null, null,
          '00000000-0000-0000-0000-000000000002',
          'ios', '1.0.0', 'production', 'cohort-2', null, null, null, 2000
        )
      `),
    ).not.toThrow();
  });

  it.each([
    ["UNKNOWN", "null", "null"],
    ["UPDATE_APPLIED", "null", "'appVersion'"],
    ["RECOVERED", "'00000000-0000-0000-0000-000000000001'", "null"],
    ["UNCHANGED", "'00000000-0000-0000-0000-000000000001'", "null"],
    ["UNCHANGED", "null", "'fingerprint'"],
    ["UPDATE_APPLIED", "'00000000-0000-0000-0000-000000000001'", "'invalid'"],
  ])(
    "rejects %s with from_bundle_id=%s and update_strategy=%s",
    async (type, fromBundleId, updateStrategy) => {
      // Given
      const database = await migrateV037();

      // When / Then
      expect(() =>
        database.exec(`
          insert into bundle_events (${eventColumns}) values (
            'invalid-${type}-${fromBundleId}-${updateStrategy}', '${type}',
            'install-invalid', null, null, ${fromBundleId},
            '00000000-0000-0000-0000-000000000002',
            'ios', '1.0.0', 'production', 'cohort', ${updateStrategy},
            null, null, 3000
          )
        `),
      ).toThrow();
    },
  );

  it("keeps to_bundle_id required for UNCHANGED rows", async () => {
    // Given
    const database = await migrateV037();

    // When / Then
    expect(() =>
      database.exec(`
        insert into bundle_events (${eventColumns}) values (
          'event-null-target', 'UNCHANGED', 'install-2', null, null, null,
          null, 'ios', '1.0.0', 'production', 'cohort-2', null,
          null, null, 2000
        )
      `),
    ).toThrow();
  });

  it("returns an empty migration after the v0.38 version write", async () => {
    // Given
    const database = await migrateV037();
    const migrator = createKyselyMigrator({
      db: createKysely(database),
      provider: "sqlite",
    });

    // When
    const rerun = await migrator.migrateToLatest({ mode: "from-schema" });

    // Then
    expect(rerun.operations).toEqual([]);
    expect(rerun.getSQL?.()).toBe("");
  });

  it("rejects downgrade because the v0.38 release is forward-only", async () => {
    // Given
    const database = await migrateV037();
    const migrator = createKyselyMigrator({
      db: createKysely(database),
      provider: "sqlite",
    });

    // When / Then
    await expect(migrator.down()).rejects.toThrow(
      "No previous schema to migrate to.",
    );
  });
});
