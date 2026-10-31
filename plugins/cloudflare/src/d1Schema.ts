import {
  coreTarget,
  createTableStatements,
  WRITE_GUARD_TABLE,
  generateEngineSql,
  type ToolingTarget,
} from "@hot-updater/plugin-core";

/**
 * D1's schema: the guard table batch writes need, then the shared SQL
 * schema of core and the target's plugins, settings last. Every statement can
 * run again, so a migration for a server's plugin tables repeats core's.
 */
export const d1SchemaStatements = ({
  schema,
  settings,
}: ToolingTarget = coreTarget): string[] => [
  ...createTableStatements("sqlite", [WRITE_GUARD_TABLE]),
  ...generateEngineSql("sqlite", schema, settings),
];

const HEADER = "-- HotUpdater.schema\n\n";

const toSql = (statements: readonly string[]) =>
  `${HEADER}${statements.map((statement) => `${statement};`).join("\n\n")}\n`;

/** The schema as a D1 migration, which `wrangler d1 migrations apply` runs. */
export const d1SchemaSql = (target?: ToolingTarget): string =>
  toSql(d1SchemaStatements(target));

/** The statements of a migration `d1SchemaSql` or `d1MigrationSql` wrote. */
export const d1MigrationStatements = (sql: string): string[] =>
  sql
    .replace(HEADER, "")
    .split(";\n\n")
    .map((statement) => statement.replace(/;\n$/u, "").trim())
    .filter((statement) => statement !== "");

/**
 * A managed D1 migration after the first: each statement of the target's
 * schema that no earlier migration ran, then every settings row, so the
 * migration is never empty and the fence passes once it ran. Shipped
 * migrations are frozen; a schema change goes into the next one.
 */
export const d1MigrationSql = (
  target: ToolingTarget,
  earlier: readonly string[],
): string => {
  const statements = d1SchemaStatements(target);
  const settings = Object.keys(target.settings).length;
  const ran = new Set(earlier.flatMap(d1MigrationStatements));
  return toSql([
    ...statements.slice(0, -settings).filter((sql) => !ran.has(sql)),
    ...statements.slice(-settings),
  ]);
};
