import { InsightsQueryNotReadyError } from "@hot-updater/plugin-core";
import {
  createIndexedInsightsEventQueries,
  type DatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import { sql, type QueryExecutorProvider } from "kysely";

const GLOBAL_INDEX = ["received_at_ms", "id"];
const BUNDLE_INDEXES = [
  ["type", "to_bundle_id", "received_at_ms", "id"],
  ["type", "from_bundle_id", "received_at_ms", "id"],
];

export const createPostgresInsightsEventQueries = (
  db: QueryExecutorProvider,
  implementation: DatabasePluginImplementation,
) =>
  createIndexedInsightsEventQueries(
    implementation,
    ["all", "bundle"],
    async (input) => {
      // One catalog read per logical page, after validating its input/cursor. Do
      // not cache readiness indefinitely: an index can disappear during deployment.
      // UUIDs share canonical string order; arbitrary text collations may not.
      const { rows } = await sql<{
        uuid_id: boolean;
        columns: readonly string[];
      }>`select a.atttypid = 'uuid'::regtype as uuid_id,
      array(select pg_get_indexdef(i.indexrelid, n, false)
        from generate_series(1, i.indnkeyatts) n) as columns
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_am am on am.oid = c.relam
    join pg_attribute a on a.attrelid = i.indrelid and a.attname = 'id'
    where i.indrelid = to_regclass('bundle_events')
      and i.indisvalid and i.indisready
      and i.indpred is null and i.indexprs is null
      and am.amname = 'btree'
      and not exists (select 1 from unnest(i.indoption) option_bits
        where option_bits <> 0)
      and not exists (select 1 from unnest(i.indclass) class_id
        join pg_opclass opclass on opclass.oid = class_id
        where not opclass.opcdefault)`.execute(db);
      const required =
        input.scope.kind === "all" ? [GLOBAL_INDEX] : BUNDLE_INDEXES;
      if (
        !required.every((columns) =>
          rows.some(
            (row) =>
              row.uuid_id &&
              columns.length === row.columns.length &&
              columns.every((column, index) => column === row.columns[index]),
          ),
        )
      ) {
        throw new InsightsQueryNotReadyError();
      }
    },
  );
