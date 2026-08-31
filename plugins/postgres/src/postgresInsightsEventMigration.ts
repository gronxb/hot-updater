import { readFile } from "node:fs/promises";

import { sql, type Kysely } from "kysely";

import { assertPostgresInsightsInstallationEventIndexes } from "./postgresInsights";

export const getPostgresInsightsInstallationEventsMigrationSQL =
  (): Promise<string> =>
    readFile(
      new URL("../sql/insights-installation-events-v1.sql", import.meta.url),
      "utf8",
    );

/** Explicit tooling only. Concurrent index construction must use a root connection. */
export const migratePostgresInsightsInstallationEvents = async <
  TDatabase extends object,
>(
  db: Kysely<TDatabase>,
): Promise<void> => {
  if (db.isTransaction)
    throw new Error(
      "Installation event migration requires a root database connection.",
    );
  const migration = await getPostgresInsightsInstallationEventsMigrationSQL();
  await db.connection().execute(async (connection) => {
    // A blocking advisory-lock SELECT can hold an old snapshot that concurrent
    // index construction waits for. Fail fast instead of forming that deadlock.
    const lock = await sql<{
      acquired: boolean;
    }>`select pg_try_advisory_lock(hashtext('hot-updater:insights-installation-events:v1')) as acquired`.execute(
      connection,
    );
    if (!lock.rows[0]?.acquired)
      throw new Error("Installation event migration is already running.");
    try {
      const { rows } = await sql<{ present: boolean }>`select
        to_regclass('bundle_events_install_applied_idx') is not null or
        to_regclass('bundle_events_install_recovered_idx') is not null as present`.execute(
        connection,
      );
      if (rows[0]?.present) {
        // No silent replacement of invalid, incomplete, or differently shaped
        // indexes left by an interrupted deployment. Repair is explicit.
        await assertPostgresInsightsInstallationEventIndexes(connection);
        return;
      }
      for (const statement of migration
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean))
        await sql.raw(statement).execute(connection);
      await assertPostgresInsightsInstallationEventIndexes(connection);
    } finally {
      await sql`select pg_advisory_unlock(hashtext('hot-updater:insights-installation-events:v1'))`.execute(
        connection,
      );
    }
  });
};
