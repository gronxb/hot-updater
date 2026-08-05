import { sql, type Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { AnalyticsSchemaNotReadyError } from "../provider/migration";
import type { BundleEventPersistenceRow } from "../provider/persistence";
import { createKyselyAnalyticsPersistence } from "./kysely";
import { migrateKyselyAnalyticsSchema } from "./kyselyMigration";
import {
  createKyselyTestDatabase,
  type KyselyTestDatabase,
} from "./kyselyTestDatabase";

const databases: KyselyTestDatabase[] = [];

const createDatabase = async (ready = true): Promise<Kysely<object>> => {
  const testDatabase = createKyselyTestDatabase();
  const database = testDatabase.database;
  await sql
    .raw(`
    create table private_hot_updater_settings (
      key text primary key,
      value text not null
    )
  `)
    .execute(database);
  await sql
    .raw(`
    insert into private_hot_updater_settings (key, value)
    values ('version', '0.36.0')
  `)
    .execute(database);
  databases.push(testDatabase);
  if (ready) {
    await migrateKyselyAnalyticsSchema({
      db: database,
      dialect: "postgresql",
    });
  }
  return database;
};

const event = (
  id: string,
  receivedAtMs: number,
  type: "UPDATE_APPLIED" | "RECOVERED" = "UPDATE_APPLIED",
): BundleEventPersistenceRow => ({
  id,
  type,
  install_id: `install-${id}`,
  user_id: null,
  username: null,
  from_bundle_id: "00000000-0000-0000-0000-000000000001",
  to_bundle_id: "00000000-0000-0000-0000-000000000002",
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "cohort-1",
  update_strategy: "appVersion",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

afterEach(async () => {
  for (const database of databases.splice(0)) await database.destroy();
});

describe("createKyselyAnalyticsPersistence", () => {
  it("appends and parses every analytics event variant", async () => {
    const database = await createDatabase();
    const persistence = createKyselyAnalyticsPersistence({
      db: database,
      dialect: "postgresql",
    });
    const rows: readonly BundleEventPersistenceRow[] = [
      event("00000000-0000-0000-0000-000000000011", 1),
      event("00000000-0000-0000-0000-000000000012", 2, "RECOVERED"),
      {
        ...event("00000000-0000-0000-0000-000000000013", 3),
        type: "UNCHANGED",
        from_bundle_id: null,
        update_strategy: null,
      },
    ];

    for (const row of rows) await persistence.append(row);
    const stored = await persistence.scan({
      beforeReceivedAtMs: 4,
      limit: 10,
    });

    expect(stored).toEqual(rows);
  });

  it("uses exclusive bounds and the id tie-breaker in ascending scans", async () => {
    const database = await createDatabase();
    const persistence = createKyselyAnalyticsPersistence({
      db: database,
      dialect: "postgresql",
    });
    const rows = [
      event("00000000-0000-0000-0000-00000000001c", 1),
      event("00000000-0000-0000-0000-00000000001a", 1),
      event("00000000-0000-0000-0000-00000000001b", 1),
      event("00000000-0000-0000-0000-00000000001d", 2),
      event("00000000-0000-0000-0000-00000000001e", 3),
    ];
    for (const row of rows) await persistence.append(row);

    const stored = await persistence.scan({
      beforeReceivedAtMs: 3,
      after: {
        receivedAtMs: 1,
        id: "00000000-0000-0000-0000-00000000001a",
      },
      limit: 2,
    });

    expect(stored.map(({ id }) => id)).toEqual([
      "00000000-0000-0000-0000-00000000001b",
      "00000000-0000-0000-0000-00000000001c",
    ]);
  });

  it("rejects duplicate event ids at the database boundary", async () => {
    const database = await createDatabase();
    const persistence = createKyselyAnalyticsPersistence({
      db: database,
      dialect: "postgresql",
    });
    const row = event("00000000-0000-0000-0000-000000000099", 1);
    await persistence.append(row);

    await expect(persistence.append(row)).rejects.toThrow();
  });

  it("retries readiness after migration", async () => {
    const database = await createDatabase(false);
    const persistence = createKyselyAnalyticsPersistence({
      db: database,
      dialect: "postgresql",
    });

    await expect(
      persistence.append(event("00000000-0000-0000-0000-000000000011", 1)),
    ).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
    await migrateKyselyAnalyticsSchema({
      db: database,
      dialect: "postgresql",
    });
    await persistence.append(event("00000000-0000-0000-0000-000000000011", 1));

    await expect(
      persistence.scan({ beforeReceivedAtMs: 2, limit: 10 }),
    ).resolves.toHaveLength(1);
  });

  it("rejects a future marker after the persistence instance is warm", async () => {
    const database = await createDatabase();
    const persistence = createKyselyAnalyticsPersistence({
      db: database,
      dialect: "postgresql",
    });
    await persistence.append(event("00000000-0000-0000-0000-000000000011", 1));
    await sql`update ${sql.table(
      "private_hot_updater_settings",
    )} set ${sql.ref("value")} = ${"3"} where ${sql.ref(
      "key",
    )} = ${"schema.analytics"}`.execute(database);

    await expect(
      persistence.scan({ beforeReceivedAtMs: 2, limit: 10 }),
    ).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
  });

  it("revalidates the catalog after a rejected marker is restored", async () => {
    const database = await createDatabase();
    const persistence = createKyselyAnalyticsPersistence({
      db: database,
      dialect: "postgresql",
    });
    await persistence.append(event("00000000-0000-0000-0000-000000000011", 1));
    await sql`update ${sql.table(
      "private_hot_updater_settings",
    )} set ${sql.ref("value")} = ${"3"} where ${sql.ref(
      "key",
    )} = ${"schema.analytics"}`.execute(database);
    await expect(
      persistence.scan({ beforeReceivedAtMs: 2, limit: 10 }),
    ).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
    await sql.raw("drop index bundle_events_received_at_idx").execute(database);
    await sql`update ${sql.table(
      "private_hot_updater_settings",
    )} set ${sql.ref("value")} = ${"2"} where ${sql.ref(
      "key",
    )} = ${"schema.analytics"}`.execute(database);

    await expect(
      persistence.scan({ beforeReceivedAtMs: 2, limit: 10 }),
    ).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
  });

  it("does not repeat full catalog validation after readiness succeeds", async () => {
    const database = await createDatabase();
    const persistence = createKyselyAnalyticsPersistence({
      db: database,
      dialect: "postgresql",
    });
    await persistence.append(event("00000000-0000-0000-0000-000000000011", 1));
    await sql.raw("drop index bundle_events_received_at_idx").execute(database);

    await expect(
      persistence.scan({ beforeReceivedAtMs: 2, limit: 10 }),
    ).resolves.toHaveLength(1);
  });

  it("rejects a deleted marker after the persistence instance is warm", async () => {
    const database = await createDatabase();
    const persistence = createKyselyAnalyticsPersistence({
      db: database,
      dialect: "postgresql",
    });
    await persistence.append(event("00000000-0000-0000-0000-000000000011", 1));
    await sql`delete from ${sql.table(
      "private_hot_updater_settings",
    )} where ${sql.ref("key")} = ${"schema.analytics"}`.execute(database);

    await expect(
      persistence.scan({ beforeReceivedAtMs: 2, limit: 10 }),
    ).rejects.toBeInstanceOf(AnalyticsSchemaNotReadyError);
  });
});
