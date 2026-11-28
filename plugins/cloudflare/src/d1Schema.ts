import {
  coreTarget,
  createTableStatements,
  WRITE_GUARD_TABLE,
  generateEngineSql,
  lateColumnStatements,
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

/** Whether `sql` creates a table an earlier migration created, which it never does again. */
const createdBefore = (sql: string, earlier: readonly string[]) => {
  const table = /^CREATE TABLE IF NOT EXISTS ("[^"]+") \(/u.exec(sql)?.[1];
  return (
    table !== undefined &&
    earlier.some((ran) =>
      ran.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`),
    )
  );
};

/**
 * A managed D1 migration after the first: the columns added to tables an
 * earlier migration created, then each statement of the target's schema that
 * no earlier migration ran, then every settings row, so the migration is
 * never empty and the fence passes once it ran. Shipped migrations are
 * frozen; a schema change goes into the next one.
 */
export const d1MigrationSql = (
  target: ToolingTarget,
  earlier: readonly string[],
): string => {
  const statements = d1SchemaStatements(target);
  const settings = Object.keys(target.settings).length;
  const ranStatements = earlier.flatMap(d1MigrationStatements);
  const ran = new Set(ranStatements);
  return toSql([
    ...lateColumnStatements("sqlite", target.schema, ranStatements),
    ...statements
      .slice(0, -settings)
      .filter((sql) => !ran.has(sql) && !createdBefore(sql, ranStatements)),
    ...statements.slice(-settings),
  ]);
};
