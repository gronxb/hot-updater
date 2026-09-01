import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventContract,
  assertInsightsEventRow,
  databaseFields,
  INSIGHTS_PAGE_MAX_ROWS,
} from "@hot-updater/plugin-core/internal";
import { sql, type QueryExecutorProvider } from "kysely";

import { fitPostgresInsightsInternalPage } from "./postgresInsightsContract";
import type {
  PostgresInsightsInstallationPage,
  PostgresInsightsInstallationPageInput,
} from "./postgresInsightsInternalTypes";

type Input = Extract<
  PostgresInsightsInstallationPageInput,
  { kind: "installation" }
>;

/** One latest event through the existing installation index, not a history scan. */
export const createPostgresInsightsInstallationLookup = (
  db: QueryExecutorProvider,
) => ({
  async pageInstallation(
    input: Input,
  ): Promise<PostgresInsightsInstallationPage> {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["kind", "installId", "limit"].includes(key),
      ) ||
      input.kind !== "installation" ||
      typeof input.installId !== "string" ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > INSIGHTS_PAGE_MAX_ROWS
    )
      throw new DatabasePluginInputError("invalid-query");

    // Check the actual key, not just the index name. Deterministic collation
    // gives exact text equality even when its ordering differs from JS strings.
    const metadata = await sql<{
      ready: boolean;
      observed_at_ms: number;
    }>`select exists (
      select 1 from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_am am on am.oid = c.relam
      join pg_attribute install on install.attrelid = i.indrelid and install.attname = 'install_id'
      join pg_attribute time on time.attrelid = i.indrelid and time.attname = 'received_at_ms'
      join pg_attribute id on id.attrelid = i.indrelid and id.attname = 'id'
      join pg_collation install_collation on install_collation.oid = install.attcollation
      where i.indexrelid = to_regclass('bundle_events_install_idx')
        and i.indrelid = to_regclass('bundle_events')
        and i.indisvalid and i.indisready and am.amname = 'btree'
        and i.indnkeyatts = 3 and i.indnatts = 3
        and i.indexprs is null and i.indpred is null
        and install.atttypid = 'text'::regtype and install.attnotnull
        and time.atttypid = 'float8'::regtype and time.attnotnull
        and id.atttypid = 'uuid'::regtype and id.attnotnull
        and i.indkey[0] = install.attnum and i.indkey[1] = time.attnum
        and i.indkey[2] = id.attnum
        and i.indcollation[0] = install.attcollation
        and i.indcollation[1] = 0 and i.indcollation[2] = 0
        and install_collation.collisdeterministic
        and not exists (select 1 from unnest(i.indoption) option_bits where option_bits <> 0)
        and not exists (select 1 from unnest(i.indclass) class_id
          join pg_opclass opclass on opclass.oid = class_id where not opclass.opcdefault)
    ) as ready,
    floor(extract(epoch from statement_timestamp()) * 1000)::float8 as observed_at_ms`.execute(
      db,
    );
    const observedAtMs = metadata.rows[0]?.observed_at_ms;
    if (!metadata.rows[0]?.ready) throw new InsightsQueryNotReadyError();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0)
      throw new DatabasePluginInputError("invalid-result");

    // PostgreSQL cannot store these text values. In particular, do not let a
    // driver encode a lone surrogate as U+FFFD and match another installation.
    const representable =
      !input.installId.includes("\0") && input.installId.isWellFormed();
    // Keep the installation key in the required order. Scalar equality lets
    // the planner drop it and choose the global time index; stale statistics
    // then caused 50,003 unrelated rows to be filtered before returning one.
    const result = representable
      ? await sql<BundleEventRow>`select ${sql.join(databaseFields.bundle_events.map((field) => sql.ref(field)))}
          from bundle_events where install_id = any(array[${input.installId}]::text[])
            and received_at_ms < ${observedAtMs}
          order by install_id desc, received_at_ms desc, id desc limit 1`.execute(
          db,
        )
      : { rows: [] };
    const rows = result.rows.map((event) => {
      assertInsightsEventRow(event);
      assertInsightsEventContract(event);
      if (
        event.install_id !== input.installId ||
        event.received_at_ms >= observedAtMs
      )
        throw new DatabasePluginInputError("invalid-result");
      const {
        id,
        install_id,
        user_id,
        username,
        to_bundle_id,
        type,
        platform,
        app_version,
        channel,
        cohort,
        received_at_ms,
      } = event;
      return {
        id,
        install_id,
        user_id,
        username,
        to_bundle_id,
        type,
        platform,
        app_version,
        channel,
        cohort,
        received_at_ms,
      };
    });
    return fitPostgresInsightsInternalPage(rows, (pageRows) => ({
      state: "ready" as const,
      consistency: "live" as const,
      observedAtMs,
      rows: pageRows,
      nextCursor: null,
    }));
  },
});
