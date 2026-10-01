import { SETTINGS_TABLE, type SchemaSettings } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import {
  createTableStatements,
  quoteSql,
  type SqlDialect,
} from "../database/sql/sqlSchema";

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
