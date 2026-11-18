import {
  createMigrator,
  InitError,
  LegacyInfrastructureError,
} from "@hot-updater/cli-tools";
import type { AnyHotUpdaterPlugin } from "@hot-updater/plugin-core";
import { postgres } from "@hot-updater/postgres";
import pg from "pg";

export type PostgresInfrastructureState = "fresh" | "v0" | "v1";

export const resolvePostgresInfrastructureState = (
  tableNames: readonly string[],
): PostgresInfrastructureState => {
  if (tableNames.includes("release_catalogs")) return "v1";
  if (tableNames.includes("bundles")) return "v0";
  return "fresh";
};

/**
 * Connects to the database and reads which Hot Updater tables its current
 * schema has. A database init cannot reach stops init before it changes
 * anything.
 */
export const readHotUpdaterTables = async (
  connectionString: string,
): Promise<string[]> => {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('bundles', 'release_catalogs')
        ORDER BY table_name`,
    );
    return rows.map((row) => row.table_name);
  } catch (error) {
    throw new InitError(
      `Could not connect to the PostgreSQL database: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
};

/** A database a Hot Updater v0 server used: `bundles` without `release_catalogs`. */
export const assertPostgresCanInitialize = (tableNames: readonly string[]) => {
  if (resolvePostgresInfrastructureState(tableNames) === "v0") {
    throw new LegacyInfrastructureError("Vercel", "PostgreSQL database");
  }
};

/** Creates or updates core's tables and the plugins' tables, with their schema settings. */
export const migratePostgres = async (
  connectionString: string,
  plugins: readonly AnyHotUpdaterPlugin[],
) => {
  const database = postgres({ connectionString });
  try {
    const migrator = createMigrator({ database, plugins });
    const result = await migrator.migrateToLatest({ updateSettings: true });
    await result.execute();
    return await migrator.getVersion();
  } finally {
    await database.dispose?.();
  }
};
