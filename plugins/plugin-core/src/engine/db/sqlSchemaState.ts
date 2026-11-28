import { LATE_COLUMNS } from "../core/schema";
import { SETTINGS_TABLE } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import type { SqlExecutor } from "../database/sql/sqlAdapter";
import {
  quoteSql,
  sqlTableShapes,
  type SqlColumnShape,
  type SqlTableShape,
} from "../database/sql/sqlSchema";

/** Each table, and the index tables of its multi-valued indexes. */
export const flattenShapes = (
  shapes: readonly SqlTableShape[],
): SqlTableShape[] =>
  shapes.flatMap((shape) => [
    shape,
    ...flattenShapes(
      shape.indexes.flatMap((index) =>
        index.kind === "table" ? [index.table] : [],
      ),
    ),
  ]);

/** Every table the target declares, settings table included, as the DDL creates it. */
export const targetShapes = (
  dialect: SqlExecutor["dialect"],
  schema: ResolvedSchema,
  tablePrefix = "",
): SqlTableShape[] =>
  flattenShapes(
    sqlTableShapes(dialect, [...schema.tables, SETTINGS_TABLE], tablePrefix),
  );

/** The tables, indexes and late columns a database holds, read from its catalog. */
export interface SqlSchemaState {
  hasTable(table: string): boolean;
  hasIndex(table: string, index: string): boolean;
  /** Whether a table holds a column; answered for `LATE_COLUMNS`' tables. */
  hasColumn(table: string, column: string): boolean;
}

/** PostgreSQL's identifier limit, NAMEDATALEN - 1 bytes. */
const POSTGRES_NAME_BYTES = 63;

/** A name as PostgreSQL stores it: cut to its limit on a character boundary. */
const postgresName = (name: string) => {
  const encoder = new TextEncoder();
  let bytes = 0;
  let cut = "";
  for (const character of name) {
    bytes += encoder.encode(character).length;
    if (bytes > POSTGRES_NAME_BYTES) break;
    cut += character;
  }
  return cut;
};

/**
 * A name as the catalog reports it, so declared and stored names compare.
 * PostgreSQL cuts a longer name to its limit. MySQL compares index names,
 * and with lower_case_table_names table names, without case, and reports
 * them folded.
 */
const fold = (dialect: SqlExecutor["dialect"], name: unknown) =>
  dialect === "mysql"
    ? String(name).toLowerCase()
    : dialect === "postgresql"
      ? postgresName(String(name))
      : String(name);

const CATALOG = {
  postgresql: {
    tables:
      "SELECT c.relname AS t FROM pg_class c WHERE c.relkind IN ('r', 'p') AND pg_table_is_visible(c.oid)",
    indexes:
      "SELECT t.relname AS t, c.relname AS i FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid WHERE pg_table_is_visible(t.oid)",
    columns:
      "SELECT c.relname AS t, a.attname AS c FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND pg_table_is_visible(c.oid)",
  },
  mysql: {
    tables:
      "SELECT TABLE_NAME AS t FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()",
    indexes:
      "SELECT DISTINCT TABLE_NAME AS t, INDEX_NAME AS i FROM information_schema.statistics WHERE TABLE_SCHEMA = DATABASE()",
    columns:
      "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE()",
  },
  sqlite: {
    tables: "SELECT name AS t FROM sqlite_master WHERE type = 'table'",
    indexes:
      "SELECT tbl_name AS t, name AS i FROM sqlite_master WHERE type = 'index'",
    columns:
      "SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'",
  },
} as const;

/** Reads which tables, indexes and columns exist: three catalog reads. */
export const readSqlSchemaState = async (
  executor: SqlExecutor,
): Promise<SqlSchemaState> => {
  const { dialect } = executor;
  const read = (sql: string) => executor.execute({ sql, params: [] });
  const [tables, indexes, columns] = await Promise.all([
    read(CATALOG[dialect].tables),
    read(CATALOG[dialect].indexes),
    read(CATALOG[dialect].columns),
  ]);
  const columnNames = new Set(
    columns.rows.map(({ t, c }) =>
      JSON.stringify([fold(dialect, t), fold(dialect, c)]),
    ),
  );
  const tableNames = new Set(tables.rows.map(({ t }) => fold(dialect, t)));
  const indexNames = new Set(
    indexes.rows.map(({ t, i }) =>
      JSON.stringify([fold(dialect, t), fold(dialect, i)]),
    ),
  );
  return {
    hasTable: (table) => tableNames.has(fold(dialect, table)),
    hasIndex: (table, index) =>
      indexNames.has(
        JSON.stringify([fold(dialect, table), fold(dialect, index)]),
      ),
    hasColumn: (table, column) =>
      columnNames.has(
        JSON.stringify([fold(dialect, table), fold(dialect, column)]),
      ),
  };
};

/** What the target declares and the database lacks. */
export interface MissingSqlSchema {
  readonly tables: readonly string[];
  /** As `<table>.<index>`, of tables that exist. */
  readonly indexes: readonly {
    readonly table: string;
    readonly index: string;
  }[];
  /** The `LATE_COLUMNS` tables that exist lack, as `ALTER TABLE` adds them. */
  readonly columns: readonly {
    readonly table: string;
    readonly column: SqlColumnShape;
  }[];
}

/**
 * The declared tables, indexes and late columns the database lacks. An index
 * on a late column is missing too while the column is.
 */
export const missingSqlSchema = (
  shapes: readonly SqlTableShape[],
  state: SqlSchemaState,
  tablePrefix = "",
): MissingSqlSchema => ({
  columns: LATE_COLUMNS.flatMap(({ table, column }) => {
    const shape = shapes.find(({ name }) => name === tablePrefix + table);
    const declared = shape?.columns.find(({ name }) => name === column);
    return shape === undefined ||
      declared === undefined ||
      !state.hasTable(shape.name) ||
      state.hasColumn(shape.name, column)
      ? []
      : [{ table: shape.name, column: declared }];
  }),
  tables: shapes
    .filter((shape) => !state.hasTable(shape.name))
    .map((shape) => shape.name),
  indexes: shapes
    .filter((shape) => state.hasTable(shape.name))
    .flatMap((shape) =>
      shape.indexes.flatMap((index) =>
        index.kind === "index" && !state.hasIndex(shape.name, index.name)
          ? [{ table: shape.name, index: index.name }]
          : [],
      ),
    ),
});

/** The collation a column's DDL type declares, such as `C` or `utf8mb4_0900_bin`. */
const declaredCollation = (type: string) =>
  /COLLATE "?([\w]+)"?/u.exec(type)?.[1];

const COLLATIONS = {
  postgresql:
    "SELECT c.relname AS t, a.attname AS c, co.collname AS k FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_collation co ON co.oid = a.attcollation WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND pg_table_is_visible(c.oid)",
  mysql:
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLLATION_NAME AS k FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND COLLATION_NAME IS NOT NULL",
} as const;

/**
 * The statements that set the collation an ORM cannot declare on each column
 * `collate` selects whose stored collation differs, one per table: PostgreSQL
 * `ALTER COLUMN … TYPE`, MySQL `MODIFY`. One catalog read; none on SQLite,
 * whose text compares by bytes already.
 */
export const collationStatements = async (
  executor: SqlExecutor,
  shapes: readonly SqlTableShape[],
  collate: (column: SqlColumnShape) => boolean,
): Promise<{ readonly statements: string[]; readonly columns: number }> => {
  const { dialect } = executor;
  if (dialect === "sqlite") return { statements: [], columns: 0 };
  const { rows } = await executor.execute({
    sql: COLLATIONS[dialect],
    params: [],
  });
  const stored = new Map(
    rows.map(({ t, c, k }) => [
      JSON.stringify([fold(dialect, t), fold(dialect, c)]),
      String(k),
    ]),
  );
  const quote = (name: string) => quoteSql(dialect, name);
  let columns = 0;
  const statements = shapes.flatMap((shape) => {
    const changes = shape.columns
      .filter((column) => {
        const expected = declaredCollation(column.type);
        return (
          expected !== undefined &&
          collate(column) &&
          stored.get(
            JSON.stringify([
              fold(dialect, shape.name),
              fold(dialect, column.name),
            ]),
          ) !== expected
        );
      })
      .map((column) =>
        dialect === "postgresql"
          ? `ALTER COLUMN ${quote(column.name)} TYPE ${column.type}`
          : `MODIFY ${quote(column.name)} ${column.type}${column.notNull ? " NOT NULL" : " NULL"}`,
      );
    columns += changes.length;
    return changes.length === 0
      ? []
      : [`ALTER TABLE ${quote(shape.name)} ${changes.join(", ")}`];
  });
  return { statements, columns };
};

/**
 * `ALTER TABLE … ADD COLUMN` for each late column a table lacks, which run
 * before the statements that create the table's indexes. Each is nullable,
 * so rows written before it read as null.
 */
export const addColumnStatements = (
  dialect: SqlExecutor["dialect"],
  columns: MissingSqlSchema["columns"],
): string[] =>
  columns.map(
    ({ table, column }) =>
      `ALTER TABLE ${quoteSql(dialect, table)} ADD COLUMN ${quoteSql(dialect, column.name)} ${column.type}`,
  );
