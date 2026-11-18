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

/** What a Blob store migration runs its statements on: a `pg` client, or PGlite. */
export interface PostgresQueryable {
  query<Row extends object>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: Row[] }>;
}

/**
 * Every column that holds a storage URI, which names its Blob store:
 * `vercel-blob://<storeId>/<key>`. Release catalogs hold bundle IDs, never a
 * URI, so moving a store changes no catalog.
 */
const STORAGE_URI_COLUMNS = [
  ["bundles", "manifest_storage_uri"],
  ["bundles", "asset_base_storage_uri"],
  ["bundle_patches", "patch_storage_uri"],
  ["native_builds", "artifact_storage_uri"],
] as const;

const storeUriPrefix = (storeId: string) => `vercel-blob://${storeId}/`;

/** The URI columns whose tables exist: an earlier release lacks native_builds. */
const existingUriColumns = async (client: PostgresQueryable) => {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1)`,
    [[...new Set(STORAGE_URI_COLUMNS.map(([table]) => table))]],
  );
  const tables = new Set(rows.map((row) => row.table_name));
  return STORAGE_URI_COLUMNS.filter(([table]) => tables.has(table));
};

/** The Blob stores the database's storage URIs name, by ID. */
export const referencedBlobStores = async (
  client: PostgresQueryable,
): Promise<Set<string>> => {
  const stores = new Set<string>();
  const prefix = "vercel-blob://";
  for (const [table, column] of await existingUriColumns(client)) {
    const { rows } = await client.query<{ store: string }>(
      `SELECT DISTINCT split_part(substr("${column}", length($1) + 1), '/', 1) AS store
         FROM "${table}"
        WHERE left("${column}", length($1)) = $1`,
      [prefix],
    );
    for (const { store } of rows) stores.add(store);
  }
  return stores;
};

/** How many storage URIs name the store. */
export const countBlobStoreReferences = async (
  client: PostgresQueryable,
  storeId: string,
): Promise<number> => {
  const prefix = storeUriPrefix(storeId);
  let count = 0;
  for (const [table, column] of await existingUriColumns(client)) {
    const { rows } = await client.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM "${table}"
        WHERE left("${column}", length($1)) = $1`,
      [prefix],
    );
    count += Number(rows[0]?.count ?? 0);
  }
  return count;
};

/**
 * Points every storage URI that names store `from` at store `to`, with the
 * same key, in one transaction; returns how many it moved. The tables stay
 * locked against writes from before `whileLocked` until the commit, so a
 * bundle written meanwhile can't be moved without its objects:
 * `whileLocked` copies what `to` still lacks. A row's `_v` advances, so a
 * write that read it before conflicts. Running it again moves nothing.
 */
export const moveBlobStoreReferences = async (
  client: PostgresQueryable,
  from: string,
  to: string,
  whileLocked: () => Promise<void> = async () => {},
): Promise<number> => {
  const [fromPrefix, toPrefix] = [storeUriPrefix(from), storeUriPrefix(to)];
  const columns = await existingUriColumns(client);
  const tables = [...new Set(columns.map(([table]) => table))];
  let moved = 0;
  await client.query("BEGIN");
  try {
    if (tables.length > 0) {
      // Reads go on; writes wait for the commit.
      await client.query(
        `LOCK TABLE ${tables.map((table) => `"${table}"`).join(", ")} IN EXCLUSIVE MODE`,
      );
    }
    await whileLocked();
    for (const [table, column] of columns) {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE "${table}"
            SET "${column}" = $2 || substr("${column}", length($1) + 1),
                "_v" = "_v" + 1
          WHERE left("${column}", length($1)) = $1
      RETURNING "id"`,
        [fromPrefix, toPrefix],
      );
      moved += rows.length;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return moved;
};

/** Runs `run` on a client connected to the database. */
export const withPostgresClient = async <T>(
  connectionString: string,
  run: (client: PostgresQueryable) => Promise<T>,
): Promise<T> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end().catch(() => undefined);
  }
};
