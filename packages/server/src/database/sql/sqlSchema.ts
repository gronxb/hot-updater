import {
  DatabaseSchemaError,
  findPhysicalColumn,
  indexOrderColumns,
  type PhysicalColumn,
  type PhysicalIndex,
  type PhysicalTable,
} from "@hot-updater/plugin-core/internal";

export type SqlDialect = "postgresql" | "mysql" | "sqlite";

/** Quotes an identifier: backticks on MySQL, double quotes elsewhere. */
export const quoteSql = (dialect: SqlDialect, name: string) =>
  dialect === "mysql"
    ? `\`${name.replaceAll("`", "``")}\``
    : `"${name.replaceAll('"', '""')}"`;

export const isMultiIndex = (table: PhysicalTable, index: PhysicalIndex) =>
  index.eq.some((column) => findPhysicalColumn(table, column).multi);

/** Keeps an identifier within PostgreSQL's 63 and MySQL's 64 characters. */
export const shortSqlName = (name: string) => {
  if (name.length <= 60) return name;
  let hash = 0x811c9dc5;
  for (const char of name)
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return `${name.slice(0, 51)}_${hash.toString(36)}`;
};

/** The column type; `entry` types one value of a multi-valued column in its index table. */
const columnType = (
  dialect: SqlDialect,
  column: PhysicalColumn,
  indexed: boolean,
  entry = false,
): string => {
  if ((column.multi && !entry) || column.type === "json") {
    return { postgresql: "jsonb", mysql: "json", sqlite: "TEXT" }[dialect];
  }
  if (column.type === "string") {
    const length = column.maxLength ?? (indexed ? 255 : undefined);
    if (dialect === "sqlite") return "TEXT";
    if (dialect === "postgresql") {
      return `${column.maxLength ? `varchar(${column.maxLength})` : "text"} COLLATE "C"`;
    }
    const charset = column.ascii
      ? "ascii COLLATE ascii_bin"
      : "utf8mb4 COLLATE utf8mb4_0900_bin";
    return `${length ? `varchar(${length})` : "longtext"} CHARACTER SET ${charset}`;
  }
  if (column.type === "integer")
    return dialect === "sqlite" ? "INTEGER" : "bigint";
  if (column.type === "number") {
    return { postgresql: "double precision", mysql: "double", sqlite: "REAL" }[
      dialect
    ];
  }
  return dialect === "sqlite" ? "INTEGER" : "boolean";
};

/** InnoDB's limit on the bytes of one key or index. */
const MYSQL_KEY_BYTES = 3072;

/** Refuses a MySQL key or index over InnoDB's limit before any DDL runs. */
const checkMysqlKey = (
  table: PhysicalTable,
  name: string,
  columns: readonly string[],
) => {
  const bytes = columns.reduce((sum, column) => {
    const { type, maxLength, ascii } = findPhysicalColumn(table, column);
    if (type === "string") return sum + (maxLength ?? 255) * (ascii ? 1 : 4);
    return sum + (type === "boolean" ? 1 : 8);
  }, 0);
  if (bytes > MYSQL_KEY_BYTES) {
    throw new DatabaseSchemaError(
      `${table.name} ${name} needs ${bytes} bytes on MySQL, over its ${MYSQL_KEY_BYTES}; shorten its strings or mark ASCII ones ascii.`,
    );
  }
};

/**
 * DDL for tables with binary collation: one table per model, one index per
 * declared index, and an index table `<table>__<index>` for each index over a
 * multi-valued field, keyed by every column it holds.
 */
export const createTableStatements = (
  dialect: SqlDialect,
  tables: readonly PhysicalTable[],
  tablePrefix = "",
): string[] => {
  const quote = (name: string) => quoteSql(dialect, name);
  const inlineIndexes = dialect === "mysql";
  const list = (columns: readonly string[]) => columns.map(quote).join(", ");
  const statements: string[] = [];
  for (const table of tables) {
    const name = tablePrefix + table.name;
    const indexed = new Set([
      ...table.key,
      ...table.indexes.flatMap(({ eq, sort }) => [...eq, ...sort]),
    ]);
    const definitions = table.columns.map(
      (column) =>
        `${quote(column.name)} ${columnType(dialect, column, indexed.has(column.name))}${column.nullable ? "" : " NOT NULL"}${column.default === undefined ? "" : ` DEFAULT ${column.default}`}`,
    );
    definitions.push(`PRIMARY KEY (${list(table.key)})`);
    if (dialect === "mysql") checkMysqlKey(table, "key", table.key);
    const indexes: string[] = [];
    for (const index of table.indexes) {
      const columns = [...index.eq, ...indexOrderColumns(table, index)];
      if (dialect === "mysql")
        checkMysqlKey(table, `index ${index.name}`, columns);
      if (isMultiIndex(table, index)) {
        const entries = columns.map(
          (column) =>
            `${quote(column)} ${columnType(dialect, findPhysicalColumn(table, column), true, true)} NOT NULL`,
        );
        indexes.push(
          `CREATE TABLE IF NOT EXISTS ${quote(`${name}__${index.name}`)} (${entries.join(", ")}, PRIMARY KEY (${list(columns)}))`,
        );
        continue;
      }
      if (!index.unique && columns.join() === table.key.join()) continue;
      const indexName = quote(shortSqlName(`${name}_${index.name}`));
      const indexColumns = list(index.unique ? index.eq : columns);
      if (inlineIndexes) {
        definitions.push(
          `${index.unique ? "UNIQUE " : ""}INDEX ${indexName} (${indexColumns})`,
        );
      } else {
        indexes.push(
          `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${indexName} ON ${quote(name)} (${indexColumns})`,
        );
      }
    }
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${quote(name)} (${definitions.join(", ")})`,
      ...indexes,
    );
  }
  return statements;
};
