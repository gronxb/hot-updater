import { readFile } from "node:fs/promises";

import { InsightsQueryNotReadyError } from "@hot-updater/plugin-core";
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";

export const assertPostgresInsightsInstallationEventIndexes = async (
  db: QueryExecutorProvider,
): Promise<void> => {
  const { rows } = await sql<{ ready: boolean }>`select count(*) = 2 as ready
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_am am on am.oid = c.relam
    join pg_attribute install on install.attrelid = i.indrelid and install.attname = 'install_id'
    join pg_attribute type on type.attrelid = i.indrelid and type.attname = 'type'
    join pg_attribute time on time.attrelid = i.indrelid and time.attname = 'received_at_ms'
    join pg_attribute id on id.attrelid = i.indrelid and id.attname = 'id'
    join pg_collation install_collation on install_collation.oid = install.attcollation
    join pg_collation type_collation on type_collation.oid = type.attcollation
    where i.indrelid = to_regclass('bundle_events')
      and ((i.indexrelid = to_regclass('bundle_events_install_applied_idx')
        and pg_get_expr(i.indpred, i.indrelid) = '(type = ''UPDATE_APPLIED''::text)')
      or (i.indexrelid = to_regclass('bundle_events_install_recovered_idx')
        and pg_get_expr(i.indpred, i.indrelid) = '(type = ''RECOVERED''::text)'))
      and i.indisvalid and i.indisready and am.amname = 'btree'
      and i.indnkeyatts = 3 and i.indnatts = 3 and i.indexprs is null
      and install.atttypid = 'text'::regtype and install.attnotnull
      and type.atttypid = 'text'::regtype and type.attnotnull
      and time.atttypid = 'float8'::regtype and time.attnotnull
      and id.atttypid = 'uuid'::regtype and id.attnotnull
      and i.indkey[0] = install.attnum and i.indkey[1] = time.attnum and i.indkey[2] = id.attnum
      and i.indcollation[0] = install.attcollation
      and i.indcollation[1] = 0 and i.indcollation[2] = 0
      and install_collation.collisdeterministic and type_collation.collisdeterministic
      and not exists (select 1 from unnest(i.indoption) option_bits where option_bits <> 0)
      and not exists (select 1 from unnest(i.indclass) class_id
        join pg_opclass opclass on opclass.oid = class_id where not opclass.opcdefault)`.execute(
    db,
  );
  if (!rows[0]?.ready) throw new InsightsQueryNotReadyError();
};

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
