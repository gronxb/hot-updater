import { sql, type RawBuilder } from "kysely";

import type {
  AnalyticsPersistence,
  AnalyticsScanInput,
  BundleEventPersistenceRow,
} from "../provider/persistence";
import { parseBundleEventPersistenceRow } from "../provider/rowParser";
import {
  createKyselyAnalyticsReadiness,
  type KyselyAnalyticsConfig,
} from "./kyselyMigration";

const columns = [
  "id",
  "type",
  "install_id",
  "user_id",
  "username",
  "from_bundle_id",
  "to_bundle_id",
  "platform",
  "app_version",
  "channel",
  "cohort",
  "update_strategy",
  "fingerprint_hash",
  "sdk_version",
  "received_at_ms",
] as const;

function cursorPredicate(input: AnalyticsScanInput): RawBuilder<boolean> {
  const receivedAtMs = sql.ref("received_at_ms");
  const eventId = sql.ref("id");
  const cursor = input.after;
  if (cursor === undefined)
    return sql<boolean>`${receivedAtMs} < ${input.beforeReceivedAtMs}`;
  return sql<boolean>`${receivedAtMs} < ${input.beforeReceivedAtMs} and (${receivedAtMs} > ${cursor.receivedAtMs} or (${receivedAtMs} = ${cursor.receivedAtMs} and ${eventId} > ${cursor.id}))`;
}

export function createKyselyAnalyticsPersistence<TDatabase extends object>(
  config: KyselyAnalyticsConfig<TDatabase>,
): AnalyticsPersistence {
  const { db } = config;
  const assertReady = createKyselyAnalyticsReadiness(config);
  return {
    async append(row: BundleEventPersistenceRow): Promise<void> {
      await assertReady();
      await sql`insert into ${sql.table("bundle_events")} (${sql.join(
        columns.map((column) => sql.ref(column)),
      )}) values (${sql.join(columns.map((column) => row[column]))})`.execute(
        db,
      );
    },
    async scan(
      input: AnalyticsScanInput,
    ): Promise<readonly BundleEventPersistenceRow[]> {
      await assertReady();
      const result = await sql<unknown>`select ${sql.join(
        columns.map((column) => sql.ref(column)),
      )} from ${sql.table("bundle_events")} where ${cursorPredicate(
        input,
      )} order by ${sql.ref("received_at_ms")} asc, ${sql.ref(
        "id",
      )} asc limit ${input.limit}`.execute(db);
      return result.rows.map(parseBundleEventPersistenceRow);
    },
  };
}

export {
  createKyselyAnalyticsMigrationStore,
  migrateKyselyAnalyticsSchema,
  InvalidKyselyAnalyticsSettingError,
  type KyselyAnalyticsConfig,
  type KyselyAnalyticsMigrationStore,
} from "./kyselyMigration";
export {
  KYSELY_ANALYTICS_DIALECTS,
  UnsupportedKyselyAnalyticsDialectError,
  type KyselyAnalyticsDialect,
} from "./kyselyMigrationSql";
