import { readFile } from "node:fs/promises";

import { sql, type Kysely } from "kysely";

import { assertPostgresInsightsAliasIndex } from "./postgresInsightsAliases";
import { assertPostgresInsightsReportClaimIndex } from "./postgresInsightsJobs";
import { assertPostgresInsightsReportDataIndexes } from "./postgresInsightsReportData";
import { assertPostgresInsightsReportOrderIndexes } from "./postgresInsightsReportOrder";
import { assertPostgresInsightsSourceIndex } from "./postgresInsightsSource";

export { createPostgresInsightsReportWorker } from "./postgresInsightsReports";
export { createPostgresInsightsSourceTools } from "./postgresInsightsSource";

export const getPostgresInsightsSourceMigrationSQL = (): Promise<string> =>
  readFile(new URL("../sql/insights-source-v1.sql", import.meta.url), "utf8");

/** Explicit DB tooling: schema cutover only, never a data backfill. */
export const migratePostgresInsightsSource = async <TDatabase extends object>(
  db: Kysely<TDatabase>,
): Promise<void> => {
  if (db.isTransaction)
    throw new Error("Source migration requires a root database connection.");
  const migration = await getPostgresInsightsSourceMigrationSQL();
  await db.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtext('hot-updater:insights-source:v1'))`.execute(
      transaction,
    );
    const installed = await sql<{ present: boolean }>`select
      to_regclass('private_hot_updater_insights_source_state') is not null as present`.execute(
      transaction,
    );
    if (installed.rows[0]?.present) {
      const version = await sql<{ version: number }>`select version from
        private_hot_updater_insights_source_state where id = 1`.execute(
        transaction,
      );
      if (version.rows[0]?.version !== 1)
        throw new Error("Invalid PostgreSQL Insights source layout.");
      await assertPostgresInsightsSourceIndex(transaction);
      return;
    }
    // This owned migration consists only of plain DDL, without function bodies.
    for (const statement of migration
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await sql.raw(statement).execute(transaction);
    }
    await assertPostgresInsightsSourceIndex(transaction);
  });
};

export const getPostgresInsightsReportMigrationSQL =
  async (): Promise<string> => {
    const jobs = await readFile(
      new URL("../sql/insights-reports-v1.sql", import.meta.url),
      "utf8",
    );
    const data = await readFile(
      new URL("../sql/insights-report-data-v1.sql", import.meta.url),
      "utf8",
    );
    const order = await readFile(
      new URL("../sql/insights-report-order-v1.sql", import.meta.url),
      "utf8",
    );
    const aliases = await readFile(
      new URL("../sql/insights-aliases-v1.sql", import.meta.url),
      "utf8",
    );
    return `${jobs}\n${data}\n${order}\n${aliases}`;
  };

/** Creates empty report storage. Does not reserve jobs or read raw events. */
export const migratePostgresInsightsReports = async <TDatabase extends object>(
  db: Kysely<TDatabase>,
): Promise<void> => {
  if (db.isTransaction)
    throw new Error("Report migration requires a root database connection.");
  const migration = await getPostgresInsightsReportMigrationSQL();
  await db.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(hashtext('hot-updater:insights-reports:v1'))`.execute(
      transaction,
    );
    const installed = await sql<{ present: boolean }>`select
      to_regclass('private_hot_updater_insights_report_heads') is not null as present`.execute(
      transaction,
    );
    if (!installed.rows[0]?.present) {
      for (const statement of migration
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean))
        await sql.raw(statement).execute(transaction);
    }
    // A partial/damaged layout requires deliberate repair, never automatic
    // table replacement or a raw-history fallback during a request.
    await assertPostgresInsightsReportClaimIndex(transaction);
    await assertPostgresInsightsReportDataIndexes(transaction);
    await assertPostgresInsightsReportOrderIndexes(transaction);
    await assertPostgresInsightsAliasIndex(transaction);
  });
};
