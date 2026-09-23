import { SETTINGS_TABLE, type SchemaSettings } from "../database/fence";
import type { ResolvedSchema } from "../database/resolveSchema";
import {
  createTableStatements,
  quoteSql,
  shortSqlName,
  type SqlDialect,
} from "../database/sql/sqlSchema";

export interface EngineSqlOptions {
  readonly tablePrefix?: string;
  /**
   * Database foreign keys for `restrict` and `cascade` references (default
   * true); E2 drops them. SQLite gets none, as its foreign keys are off by
   * default.
   */
  readonly foreignKeys?: boolean;
}

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** Foreign keys for the schema's `restrict` and `cascade` references. */
export const foreignKeyStatements = (
  dialect: SqlDialect,
  schema: ResolvedSchema,
  tablePrefix = "",
): string[] => {
  if (dialect === "sqlite") return [];
  const quote = (name: string) => quoteSql(dialect, name);
  return [...schema.models.values()].flatMap(({ references }) =>
    references.flatMap(({ table, field, target, onDelete }) => {
      if (onDelete === "none") return [];
      const [key] = schema.models.get(target)!.table.key;
      const constraint = quote(
        shortSqlName(`${tablePrefix}${table}_${field}_fk`),
      );
      const statement = `ALTER TABLE ${quote(tablePrefix + table)} ADD CONSTRAINT ${constraint} FOREIGN KEY (${quote(field)}) REFERENCES ${quote(tablePrefix + target)} (${quote(key!)}) ON DELETE ${onDelete.toUpperCase()}`;
      // PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS; this keeps a rerun safe.
      return dialect === "postgresql"
        ? [
            `DO $$ BEGIN ${statement}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
          ]
        : [statement];
    }),
  );
};

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
 * A resolved schema as SQL: its tables and indexes, then foreign keys, then
 * the settings rows last, so the fence passes only once everything exists.
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
  ...(options.foreignKeys === false
    ? []
    : foreignKeyStatements(dialect, schema, options.tablePrefix)),
  ...settingsStatements(dialect, settings, options.tablePrefix),
];
