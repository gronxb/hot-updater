import { sql, type Kysely } from "kysely";

import type { AnalyticsPhysicalIndex } from "../provider/schemaFingerprint.js";
import type {
  KyselyAnalyticsCatalog,
  KyselyAnalyticsCatalogCheck,
} from "./kyselySchemaCatalog.js";

type CatalogWithoutColumns = Omit<KyselyAnalyticsCatalog, "columns">;

type CatalogConstraint = {
  readonly definition: string | null;
  readonly enforced: boolean | number | string | null;
  readonly name: string;
  readonly type: string;
};

type MysqlIndexRow = {
  readonly column_name: string;
  readonly index_name: string;
  readonly index_type: string;
  readonly is_visible: string;
  readonly non_unique: number;
  readonly seq_in_index: number;
  readonly sub_part: number | null;
};

const postgresBtreeIndexPattern = /\busing\s+btree\s*\(([^()]*)\)\s*$/i;

function extractSqliteChecks(
  tableSql: string,
): readonly KyselyAnalyticsCatalogCheck[] {
  const checks: KyselyAnalyticsCatalogCheck[] = [];
  const pattern = /(?:constraint\s+([a-z0-9_]+)\s+)?check\s*\(/gi;
  for (const match of tableSql.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let cursor = start;
    let quoted = false;
    for (; cursor < tableSql.length && depth > 0; cursor += 1) {
      const character = tableSql[cursor];
      if (character === "'") quoted = !quoted;
      if (quoted) continue;
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
    }
    checks.push({
      definition: tableSql.slice(start, cursor - 1),
      enforced: true,
      name: match[1] ?? "",
    });
  }
  return checks;
}

export async function inspectSqliteAnalyticsCatalog<TDatabase extends object>(
  db: Kysely<TDatabase>,
): Promise<CatalogWithoutColumns> {
  const indexList = await sql<{
    readonly name: string;
    readonly origin: string;
    readonly partial: number;
    readonly unique_value: number;
  }>`
    select name, origin, partial, "unique" as unique_value
    from pragma_index_list('bundle_events')
  `.execute(db);
  const indexes = await Promise.all(
    indexList.rows.map(
      async (index): Promise<AnalyticsPhysicalIndex> => ({
        columns: (
          await sql<{ readonly name: string }>`
          select coalesce(name, 'analytics-expression-index-drift') as name
          from pragma_index_info(${index.name}) order by seqno
        `.execute(db)
        ).rows.map(({ name }) => name),
        name: index.name,
        unique: index.unique_value === 1,
      }),
    ),
  );
  const table = await sql<{ readonly sql_text: string }>`
    select sql as sql_text from sqlite_master
    where type = 'table' and name = 'bundle_events'
  `.execute(db);
  const primary = indexList.rows.find(({ origin }) => origin === "pk");
  const primaryIndex = indexes.find(({ name }) => name === primary?.name);
  return {
    checks: extractSqliteChecks(table.rows[0]?.sql_text ?? ""),
    foreignKeys: (
      await sql<{ readonly id: number }>`
        select id from pragma_foreign_key_list('bundle_events')
      `.execute(db)
    ).rows.map(({ id }) => String(id)),
    indexes: indexes.filter(({ name }) => name !== primary?.name),
    invalidIndexes: indexList.rows
      .filter(
        ({ origin, partial }) =>
          (origin !== "c" && origin !== "pk") || partial !== 0,
      )
      .map(({ name }) => name),
    primaryKey: primaryIndex?.columns ?? [],
    unexpectedConstraints: [],
  };
}

export async function inspectPostgresAnalyticsCatalog<TDatabase extends object>(
  db: Kysely<TDatabase>,
): Promise<CatalogWithoutColumns> {
  const constraints = await sql<CatalogConstraint>`
    select conname as name, contype as type,
      pg_get_constraintdef(oid) as definition, convalidated as enforced
    from pg_constraint where conrelid = 'bundle_events'::regclass
  `.execute(db);
  const indexRows = await sql<{
    readonly definition: string;
    readonly is_ready: boolean;
    readonly is_valid: boolean;
    readonly name: string;
  }>`
    select index_class.relname as name,
      pg_get_indexdef(index_state.indexrelid) as definition,
      index_state.indisready as is_ready,
      index_state.indisvalid as is_valid
    from pg_index index_state
    join pg_class index_class on index_class.oid = index_state.indexrelid
    where index_state.indrelid = 'bundle_events'::regclass
  `.execute(db);
  const indexes = indexRows.rows.map(({ definition, name }) => {
    const match = postgresBtreeIndexPattern.exec(definition);
    return {
      columns:
        match?.[1]
          ?.split(",")
          .map((column) => column.replaceAll('"', "").trim()) ?? [],
      name,
      unique: /^create\s+unique\s+index/i.test(definition),
    };
  });
  return catalogFromConstraints(
    constraints.rows,
    indexes,
    indexRows.rows
      .filter(
        ({ definition, is_ready, is_valid }) =>
          !is_ready || !is_valid || !postgresBtreeIndexPattern.test(definition),
      )
      .map(({ name }) => name),
  );
}

function mysqlPrefixIsExact({
  column_name: column,
  sub_part: prefix,
}: MysqlIndexRow): boolean {
  switch (column) {
    case "type":
    case "install_id":
    case "user_id":
    case "username":
    case "cohort":
      return prefix === 255;
    default:
      return prefix === null;
  }
}

export async function inspectMysqlAnalyticsCatalog<TDatabase extends object>(
  db: Kysely<TDatabase>,
): Promise<CatalogWithoutColumns> {
  const constraints = await sql<CatalogConstraint>`
    select tc.constraint_name as name, tc.constraint_type as type,
      cc.check_clause as definition, tc.enforced as enforced
    from information_schema.table_constraints tc
    left join information_schema.check_constraints cc
      on cc.constraint_schema = tc.constraint_schema
      and cc.constraint_name = tc.constraint_name
    where tc.table_schema = database() and tc.table_name = 'bundle_events'
  `.execute(db);
  const indexRows = await sql<MysqlIndexRow>`
    select index_name as index_name, column_name as column_name,
      seq_in_index as seq_in_index, non_unique as non_unique,
      sub_part as sub_part, index_type as index_type,
      is_visible as is_visible
    from information_schema.statistics
    where table_schema = database() and table_name = 'bundle_events'
    order by index_name, seq_in_index
  `.execute(db);
  const indexNames = [
    ...new Set(indexRows.rows.map(({ index_name }) => index_name)),
  ];
  const indexes = indexNames.map((name): AnalyticsPhysicalIndex => {
    const rows = indexRows.rows.filter(({ index_name }) => index_name === name);
    return {
      columns: rows.map(({ column_name }) => column_name),
      name,
      unique: rows.every(({ non_unique }) => non_unique === 0),
    };
  });
  return catalogFromConstraints(
    constraints.rows,
    indexes,
    indexRows.rows
      .filter(
        (row) =>
          row.index_type !== "BTREE" ||
          row.is_visible !== "YES" ||
          !mysqlPrefixIsExact(row),
      )
      .map(({ index_name }) => index_name),
  );
}

function catalogFromConstraints(
  constraints: readonly CatalogConstraint[],
  indexes: readonly AnalyticsPhysicalIndex[],
  invalidIndexes: readonly string[],
): CatalogWithoutColumns {
  const primary = constraints.find(
    ({ type }) => type === "p" || type === "PRIMARY KEY",
  );
  const primaryName = primary?.name ?? "PRIMARY";
  return {
    checks: constraints
      .filter(({ type }) => type === "c" || type === "CHECK")
      .map(({ definition, enforced, name }) => ({
        definition: definition ?? "",
        enforced: enforced === true || enforced === 1 || enforced === "YES",
        name,
      })),
    foreignKeys: constraints
      .filter(({ type }) => type === "f" || type === "FOREIGN KEY")
      .map(({ name }) => name),
    indexes: indexes.filter(({ name }) => name !== primaryName),
    invalidIndexes: [...new Set(invalidIndexes)],
    primaryKey: indexes.find(({ name }) => name === primaryName)?.columns ?? [],
    unexpectedConstraints: constraints
      .filter(
        ({ type }) =>
          !["c", "f", "p", "CHECK", "FOREIGN KEY", "PRIMARY KEY"].includes(
            type,
          ),
      )
      .map(({ name }) => name),
  };
}
