import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  createIndexedInsightsEventQueries,
  databaseFields,
  type DatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import { sql, type QueryExecutorProvider } from "kysely";

const GLOBAL_INDEX = ["received_at_ms", "id"];
const BUNDLE_INDEXES = [
  ["type", "to_bundle_id", "received_at_ms", "id"],
  ["type", "from_bundle_id", "received_at_ms", "id"],
];
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

export const createPostgresInsightsEventQueries = (
  db: QueryExecutorProvider,
  implementation: DatabasePluginImplementation,
) =>
  createIndexedInsightsEventQueries(
    {
      ...implementation,
      async findMany(input) {
        if (
          input.model !== "bundle_events" ||
          input.where?.[0]?.field !== "install_id"
        )
          return implementation.findMany(input);
        const installId = input.where[0].value;
        const type = input.where[1]?.value;
        if (
          typeof installId !== "string" ||
          input.where[1]?.field !== "type" ||
          (type !== "UPDATE_APPLIED" && type !== "RECOVERED")
        )
          throw new DatabasePluginInputError("invalid-query");
        // This private executor receives only the shared helper's finite stream
        // queries. Literal types let partial indexes work with generic plans too.
        // Do not encode lone surrogates as U+FFFD and match a different identity.
        if (installId.includes("\0") || !installId.isWellFormed()) return [];
        const predicates = input.where.map((filter) => {
          if (filter.field === "type") return sql`type = ${sql.lit(type)}`;
          // Keep the leading installation order key in the plan. Plain equality
          // lets PostgreSQL discard it and choose the global time index, which
          // can scan a newer unrelated burst when statistics lag behind writes.
          if (filter.field === "install_id")
            return sql`install_id = any(array[${installId}]::text[])`;
          const operator = filter.operator ?? "eq";
          if (
            !["install_id", "received_at_ms", "id"].includes(filter.field) ||
            !["eq", "lt", "gte"].includes(operator)
          )
            throw new DatabasePluginInputError("invalid-query");
          return sql`${sql.ref(filter.field)} ${sql.raw(operator === "eq" ? "=" : operator === "lt" ? "<" : ">=")} ${filter.value}`;
        });
        const { rows } =
          await sql<BundleEventRow>`select ${sql.join(databaseFields.bundle_events.map((field) => sql.ref(field)))}
          from ${sql.table("bundle_events")} where ${sql.join(predicates, sql` and `)}
          order by install_id desc, received_at_ms desc, id desc limit ${input.limit}`.execute(
            db,
          );
        return rows;
      },
    },
    ["all", "bundle", "installation"],
    async (input, cursor) => {
      if (
        (input.scope.kind === "bundle" &&
          !CANONICAL_UUID.test(input.scope.bundleId)) ||
        (cursor !== undefined && !CANONICAL_UUID.test(cursor.id))
      ) {
        throw new DatabasePluginInputError("invalid-query");
      }
      if (input.scope.kind === "installation") {
        await assertPostgresInsightsInstallationEventIndexes(db);
        return;
      }
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
