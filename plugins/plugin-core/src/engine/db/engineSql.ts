import { LATE_COLUMNS } from "../core/schema";
import { SETTINGS_TABLE, type SchemaSettings } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import {
  createTableStatements,
  quoteSql,
  sqlTableShapes,
  type SqlDialect,
} from "../database/sql/sqlSchema";

/** `generateEngineSql`'s and `createEngineSqlMigrator`'s options. */
export interface EngineSqlOptions {
  readonly tablePrefix?: string;
}

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** Upserts of the settings rows the fence reads. */
export const settingsStatements = (
  dialect: SqlDialect,
  settings: SchemaSettings,
  tablePrefix = "",
): string[] => {
  const quote = (name: string) => quoteSql(dialect, name);
  const [key, value, version] = ["key", "value", "_v"].map(quote);
  return Object.entries(settings).map(([name, text]) => {
    const insert = `INSERT INTO ${quote(tablePrefix + SETTINGS_TABLE.name)} (${key}, ${value}, ${version}) VALUES (${literal(name)}, ${literal(text)}, 0)`;
    return dialect === "mysql"
      ? `${insert} ON DUPLICATE KEY UPDATE ${value} = VALUES(${value})`
      : `${insert} ON CONFLICT (${key}) DO UPDATE SET ${value} = excluded.${value}`;
  });
};

/**
 * A resolved schema as SQL: its tables and indexes, then the settings rows
 * last, so the fence passes only once everything exists. There are no
 * database foreign keys: the engine keeps references itself.
 */
export const generateEngineSql = (
  dialect: SqlDialect,
  schema: ResolvedSchema,
  settings: SchemaSettings,
  options: EngineSqlOptions = {},
): string[] => [
  ...createTableStatements(
    dialect,
    [...schema.tables, SETTINGS_TABLE],
    options.tablePrefix,
  ),
  ...settingsStatements(dialect, settings, options.tablePrefix),
];

/**
 * A managed provider's numbered migration needs these: an
 * `ALTER TABLE … ADD COLUMN` for each column added to a table a released
 * schema created, where an `earlier` migration's `CREATE TABLE` lacks it. A
 * migration that diffs statements skips the changed `CREATE TABLE IF NOT
 * EXISTS`, which an existing table ignores anyway, so the D1 and Supabase
 * generators put these first, before the statements that index the column.
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so only a migration that runs once
 * holds them, never statements a later migration repeats.
 */
export const lateColumnStatements = (
  dialect: SqlDialect,
  schema: ResolvedSchema,
  earlier: readonly string[],
  { tablePrefix = "" }: EngineSqlOptions = {},
): string[] => {
  const quote = (name: string) => quoteSql(dialect, name);
  const shapes = sqlTableShapes(dialect, schema.tables, tablePrefix);
  return LATE_COLUMNS.flatMap(({ table, column }) => {
    const name = tablePrefix + table;
    const created = earlier.find((sql) =>
      sql.startsWith(`CREATE TABLE IF NOT EXISTS ${quote(name)} (`),
    );
    const declared = shapes
      .find((shape) => shape.name === name)
      ?.columns.find((candidate) => candidate.name === column);
    if (
      created === undefined ||
      declared === undefined ||
      created.includes(`${quote(column)} `)
    ) {
      return [];
    }
    return [
      `ALTER TABLE ${quote(name)} ADD COLUMN ${dialect === "postgresql" ? "IF NOT EXISTS " : ""}${quote(column)} ${declared.type}`,
    ];
  });
};
