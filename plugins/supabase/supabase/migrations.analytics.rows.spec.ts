import fs from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  "plugins/supabase/supabase/migrations/20260805000000_hot-updater_analytics_2.sql",
);
const databases: PGlite[] = [];
const invalidRows: readonly {
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

function createDatabase(): PGlite {
  const database = new PGlite();
  databases.push(database);
  return database;
}

async function migrate(database: PGlite): Promise<void> {
  await database.exec(await fs.readFile(migrationPath, "utf8"));
}

async function initializeSettings(database: PGlite): Promise<void> {
  await database.exec(`
    create table private_hot_updater_settings (
      key text primary key not null,
      value text not null
    );
    insert into private_hot_updater_settings (key, value)
    values ('version', '0.36.0');
  `);
}

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
});

describe("Supabase Analytics migration row validation", () => {
  it.each(invalidRows)(
    "rejects $caseName before adopting schema 2",
    async ({ assignment }) => {
      const database = createDatabase();
      await initializeSettings(database);
      await migrate(database);
      await database.exec(`
        insert into bundle_events (
          id, type, install_id, to_bundle_id, platform, app_version, channel,
          cohort, received_at_ms
        ) values (
          '00000000-0000-0000-0000-000000000102', 'UNCHANGED', 'install-2',
          '00000000-0000-0000-0000-000000000002', 'ios', '1.0.0',
          'production', 'default', 2000
        );
        delete from private_hot_updater_settings
        where key = 'schema.analytics';
        update bundle_events set ${assignment};
      `);

      await expect(migrate(database)).rejects.toThrow(
        "Analytics schema contains invalid bundle event rows",
      );
      await database.exec("rollback");

      const marker = await database.query<{ readonly value: string }>(
        "select value from private_hot_updater_settings where key = 'schema.analytics'",
      );
      expect(marker.rows).toEqual([]);
      const rows = await database.query<{ readonly count: number }>(
        "select count(*)::integer as count from bundle_events",
      );
      expect(rows.rows).toEqual([{ count: 1 }]);
    },
  );

  it("rolls back a legacy v1 mutation when persisted data is invalid", async () => {
    const database = createDatabase();
    await initializeSettings(database);
    await migrate(database);
    await database.exec(`
      delete from private_hot_updater_settings where key = 'schema.analytics';
      update private_hot_updater_settings set value = '0.37.0'
        where key = 'version';
      alter table bundle_events
        drop constraint bundle_events_type_v038_check,
        drop constraint bundle_events_update_strategy_v038_check,
        drop constraint bundle_events_shape_v038_check,
        alter column from_bundle_id set not null,
        alter column update_strategy set not null,
        add constraint bundle_events_type_check
          check (type in ('UPDATE_APPLIED', 'RECOVERED')),
        add constraint bundle_events_update_strategy_check
          check (update_strategy in ('fingerprint', 'appVersion'));
      insert into bundle_events (
        id, type, install_id, from_bundle_id, to_bundle_id, platform,
        app_version, channel, cohort, update_strategy, received_at_ms
      ) values (
        '00000000-0000-0000-0000-000000000103', 'UPDATE_APPLIED', 'install-3',
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002', 'web', '1.0.0',
        'production', 'default', 'appVersion', 2000
      );
    `);

    await expect(migrate(database)).rejects.toThrow(
      "Analytics schema contains invalid bundle event rows",
    );
    await database.exec("rollback");

    const state = await database.query<{
      readonly is_nullable: string;
      readonly marker_count: number;
    }>(`
      select is_nullable, (
        select count(*)::integer from private_hot_updater_settings
        where key = 'schema.analytics'
      ) as marker_count from information_schema.columns
      where table_name = 'bundle_events' and column_name = 'from_bundle_id'
    `);
    expect(state.rows).toEqual([{ is_nullable: "NO", marker_count: 0 }]);
  });

  it("refuses a marked schema 2 whose persisted rows are invalid", async () => {
    const database = createDatabase();
    await initializeSettings(database);
    await migrate(database);
    await database.exec(`
      insert into bundle_events (
        id, type, install_id, to_bundle_id, platform, app_version, channel,
        cohort, received_at_ms
      ) values (
        '00000000-0000-0000-0000-000000000104', 'UNCHANGED', 'install-4',
        '00000000-0000-0000-0000-000000000002', 'web', '1.0.0',
        'production', 'default', 2000
      );
    `);

    await expect(migrate(database)).rejects.toThrow(
      "Analytics schema contains invalid bundle event rows",
    );
    await database.exec("rollback");

    const state = await database.query<{
      readonly platform: string;
      readonly value: string;
    }>(`
      select events.platform, settings.value
      from bundle_events as events
      join private_hot_updater_settings as settings
        on settings.key = 'schema.analytics'
    `);
    expect(state.rows).toEqual([{ platform: "web", value: "2" }]);
  });
});
