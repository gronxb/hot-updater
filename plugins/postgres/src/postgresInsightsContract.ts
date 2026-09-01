import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
} from "@hot-updater/plugin-core";
import {
  assertInsightsPageContract,
  assertInsightsMaintenanceInputContract,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_EVENT_MAX_BYTES,
  INSIGHTS_PAGE_MAX_BYTES,
  InsightsContractError,
  isCanonicalInsightsEventId,
} from "@hot-updater/plugin-core/internal";
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";

export interface PostgresInsightsTableLayout {
  readonly table: string;
  readonly columns: readonly string[];
  readonly constraints: readonly string[];
}

/** Exact catalog shape for private owned tables; extensions are never accepted. */
export const assertPostgresInsightsTableLayouts = async (
  db: QueryExecutorProvider,
  layouts: readonly PostgresInsightsTableLayout[],
): Promise<void> => {
  const result = await sql<{ ready: boolean }>`select bool_and(
    exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.oid=to_regclass(required.table_name) and n.nspname='public'
        and c.relkind='r' and c.relpersistence='p')
    and (select array_agg(a.attname || ':' || format_type(a.atttypid,a.atttypmod)
          || ':' || a.attnotnull::text || ':' || a.atthasdef::text || ':'
          || coalesce(pg_get_expr(d.adbin,d.adrelid),'') || ':'
          || coalesce(coll.collname,'') || ':' || a.attidentity::text || ':'
          || a.attgenerated::text order by a.attnum)
        from pg_attribute a left join pg_attrdef d
          on d.adrelid=a.attrelid and d.adnum=a.attnum
        left join pg_collation coll on coll.oid=a.attcollation
        where a.attrelid=to_regclass(required.table_name)
          and a.attnum>0 and not a.attisdropped)=required.columns
    and (select array_agg(pg_get_constraintdef(c.oid,false)
          order by pg_get_constraintdef(c.oid,false))
        from pg_constraint c where c.conrelid=to_regclass(required.table_name))
      =required.constraints
    and (select bool_and(c.convalidated and not c.condeferrable
          and not c.condeferred and c.connoinherit=(c.contype<>'c'))
        from pg_constraint c where c.conrelid=to_regclass(required.table_name))
  ) ready from (values ${sql.join(
    layouts.map(
      (layout) =>
        sql`(${layout.table}::text,array[${sql.join(layout.columns)}]::text[],array[${sql.join(layout.constraints)}]::text[])`,
    ),
  )}) required(table_name,columns,constraints)`.execute(db);
  if (!result.rows[0]?.ready) throw new InsightsQueryNotReadyError();
};

export const postgresInsightsEventVariableBytes = sql`coalesce(
  octet_length(insights_event::text)::bigint,
  octet_length(type)::bigint + octet_length(install_id)::bigint +
  coalesce(octet_length(user_id), 0)::bigint +
  coalesce(octet_length(username), 0)::bigint +
  octet_length(platform)::bigint + octet_length(app_version)::bigint +
  octet_length(channel)::bigint + octet_length(cohort)::bigint +
  coalesce(octet_length(update_strategy), 0)::bigint +
  coalesce(octet_length(fingerprint_hash), 0)::bigint +
  coalesce(octet_length(sdk_version), 0)::bigint)`;

export interface PostgresInsightsEventCandidate {
  readonly id: string;
  readonly variable_bytes: string;
}

export const assertPostgresInsightsEventCandidates = (
  rows: readonly PostgresInsightsEventCandidate[],
): void => {
  for (const row of rows) {
    if (!isCanonicalInsightsEventId(row.id))
      throw new InsightsContractError("invalid-event-id");
    const bytes = Number(row.variable_bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new DatabasePluginInputError("invalid-result");
    if (bytes > INSIGHTS_EVENT_MAX_BYTES)
      throw new InsightsContractError(
        "event-too-large",
        bytes,
        INSIGHTS_EVENT_MAX_BYTES,
      );
  }
};

export const fitPostgresInsightsPage = <TRow, TPage>(
  rows: readonly TRow[],
  requestedLimit: number,
  build: (rows: readonly TRow[], shortened: boolean) => TPage,
): TPage => {
  for (let size = rows.length; size >= 0; size--) {
    const page = build(rows.slice(0, size), size < rows.length);
    try {
      assertInsightsPageContract(page, requestedLimit);
      if (size === 0 && rows.length > 0)
        throw new DatabasePluginInputError("invalid-result");
      return page;
    } catch (error) {
      if (
        !(error instanceof InsightsContractError) ||
        error.reason !== "page-too-large"
      )
        throw error;
    }
  }
  throw new DatabasePluginInputError("invalid-result");
};

export const fitPostgresInsightsInternalPage = <TRow, TPage>(
  rows: readonly TRow[],
  build: (rows: readonly TRow[], shortened: boolean) => TPage,
): TPage => {
  for (let size = rows.length; size >= 0; size--) {
    const page = build(rows.slice(0, size), size < rows.length);
    if (getCanonicalInsightsJsonByteLength(page) <= INSIGHTS_PAGE_MAX_BYTES) {
      if (size === 0 && rows.length > 0)
        throw new DatabasePluginInputError("invalid-result");
      return page;
    }
  }
  throw new DatabasePluginInputError("invalid-result");
};

export const assertPostgresInsightsMaintenanceInput = (
  input: unknown,
): void => {
  try {
    assertInsightsMaintenanceInputContract(input);
  } catch (error) {
    if (!(error instanceof InsightsContractError)) throw error;
    throw new DatabasePluginInputError("invalid-query");
  }
};

const preparationFailure = (error: unknown): string | null => {
  if (error instanceof InsightsContractError) return `contract:${error.reason}`;
  if (error instanceof DatabasePluginInputError) return `storage:${error.code}`;
  return null;
};

export const isPostgresInsightsTerminalPreparationError = (
  error: unknown,
): boolean =>
  error instanceof InsightsContractError ||
  (error instanceof DatabasePluginInputError &&
    error.code === "invalid-result");

export const recordPostgresInsightsPreparationFailure = async <
  TDatabase extends object,
>(
  db: Kysely<TDatabase>,
  table: string,
  error: unknown,
): Promise<void> => {
  const failure = preparationFailure(error);
  if (failure === null) return;
  await sql`update ${sql.table(table)} set failed=true, failure=${failure},
    ready=false where id=1 and version=1 and not ready`.execute(db);
};
