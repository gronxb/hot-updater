import {
  coreTarget,
  createTableStatements,
  WRITE_GUARD_TABLE,
} from "@hot-updater/server/database";
import { generateEngineSql, type ToolingTarget } from "@hot-updater/server/db";

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

/** The schema as a D1 migration, which `wrangler d1 migrations apply` runs. */
export const d1SchemaSql = (target?: ToolingTarget): string =>
  `-- HotUpdater.schema\n\n${d1SchemaStatements(target)
    .map((statement) => `${statement};`)
    .join("\n\n")}\n`;
