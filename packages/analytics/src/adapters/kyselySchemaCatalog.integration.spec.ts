import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { createKyselyAnalyticsMigrationStore } from "./kyselyMigration";
import {
  createAnalyticsV2Statements,
  UnsupportedKyselyAnalyticsDialectError,
} from "./kyselyMigrationSql";
import {
  createMigrationTestDatabase,
  destroyMigrationTestDatabases,
  executeMigrationTestStatements,
} from "./kyselyMigrationTestFixtures";
import { inspectKyselyAnalyticsCatalog } from "./kyselySchemaCatalog";

afterEach(async () => {
  await destroyMigrationTestDatabases();
});

describe("PostgreSQL Analytics catalog inspection", () => {
  it("rejects an unsupported runtime dialect", async () => {
    const database = await createMigrationTestDatabase([["version", "0.38.0"]]);
    await executeMigrationTestStatements(
      database,
      createAnalyticsV2Statements("postgresql"),
    );

    const inspection = Reflect.apply(inspectKyselyAnalyticsCatalog, undefined, [
      database,
      "cockroachdb",
    ]);

    await expect(inspection).rejects.toBeInstanceOf(
      UnsupportedKyselyAnalyticsDialectError,
    );
  });

  it("rejects a changed check that reuses the v2 constraint name", async () => {
    const database = await createMigrationTestDatabase([["version", "0.38.0"]]);
    await executeMigrationTestStatements(
      database,
      createAnalyticsV2Statements("postgresql"),
    );
    await sql
      .raw(`
      alter table bundle_events
      drop constraint bundle_events_shape_v038_check
    `)
      .execute(database);
    await sql
      .raw(`
      alter table bundle_events
      add constraint bundle_events_shape_v038_check check (true)
    `)
      .execute(database);

    const inspection = await createKyselyAnalyticsMigrationStore({
      db: database,
      dialect: "postgresql",
    }).inspect();

    expect(inspection.fingerprint).toBe("analytics-schema-drift");
  });

  it("rejects an exact check definition that PostgreSQL has not validated", async () => {
    const database = await createMigrationTestDatabase([["version", "0.38.0"]]);
    await executeMigrationTestStatements(
      database,
      createAnalyticsV2Statements("postgresql"),
    );
    await sql
      .raw(`
      alter table bundle_events
      drop constraint bundle_events_shape_v038_check
    `)
      .execute(database);
    await sql
      .raw(`
      alter table bundle_events add constraint bundle_events_shape_v038_check
      check (
        (type in ('UPDATE_APPLIED', 'RECOVERED')
          and from_bundle_id is not null and update_strategy is not null)
        or (type = 'UNCHANGED'
          and from_bundle_id is null and update_strategy is null)
      ) not valid
    `)
      .execute(database);

    const inspection = await createKyselyAnalyticsMigrationStore({
      db: database,
      dialect: "postgresql",
    }).inspect();

    expect(inspection.fingerprint).toBe("analytics-schema-drift");
  });

  it("rejects an index PostgreSQL reports as invalid", async () => {
    const database = await createMigrationTestDatabase([["version", "0.38.0"]]);
    await executeMigrationTestStatements(
      database,
      createAnalyticsV2Statements("postgresql"),
    );
    await sql
      .raw(`
      update pg_index set indisvalid = false
      where indexrelid = 'bundle_events_received_at_idx'::regclass
    `)
      .execute(database);

    const inspection = await createKyselyAnalyticsMigrationStore({
      db: database,
      dialect: "postgresql",
    }).inspect();

    expect(inspection.fingerprint).toBe("analytics-schema-drift");
  });

  it("rejects an index PostgreSQL reports as not ready", async () => {
    const database = await createMigrationTestDatabase([["version", "0.38.0"]]);
    await executeMigrationTestStatements(
      database,
      createAnalyticsV2Statements("postgresql"),
    );
    await sql
      .raw(`
      update pg_index set indisready = false
      where indexrelid = 'bundle_events_received_at_idx'::regclass
    `)
      .execute(database);

    const inspection = await createKyselyAnalyticsMigrationStore({
      db: database,
      dialect: "postgresql",
    }).inspect();

    expect(inspection.fingerprint).toBe("analytics-schema-drift");
  });
});
