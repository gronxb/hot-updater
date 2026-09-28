import type {
  EngineDatabase,
  HotUpdaterCoreApi,
} from "@hot-updater/plugin-core";
import type { DatabaseAdapter } from "@hot-updater/plugin-core/internal";

import { createDatabaseEngine } from "../database/database";
import { resolveSchema } from "../database/resolveSchema";
import { createCoreOperations } from "./operations";
import { createCoreReads, type CoreDatabase, type CoreStorage } from "./reads";
import { coreModule } from "./schema";

export interface CoreApiOptions {
  readonly now?: () => number;
  /** The database's CDN purge, called after a write that changes a Release Catalog. */
  readonly onCachedRoutesChange?: () => Promise<void>;
}

/**
 * The update check answers from one Release Catalog row, so a transaction
 * changes what the cacheable client routes answer only when it writes one.
 * The purge runs once, after the attempt that commits.
 */
const purgingCachedRoutes = (
  db: CoreDatabase,
  onCachedRoutesChange: (() => Promise<void>) | undefined,
): CoreDatabase => {
  if (onCachedRoutesChange === undefined) return db;
  return {
    ...db,
    async transaction(fn) {
      let changed = false;
      const result = await db.transaction((tx) => {
        changed = false;
        return fn({
          ...tx,
          create: (model, row) => {
            changed ||= model === "release_catalogs";
            tx.create(model, row);
          },
          update: (model, row, set) => {
            changed ||= model === "release_catalogs";
            tx.update(model, row, set);
          },
          delete: (model, row) => {
            changed ||= model === "release_catalogs";
            return tx.delete(model, row);
          },
        });
      });
      if (changed) await onCachedRoutesChange();
      return result;
    },
  };
};

/** Core's reads and typed writes over one database handle. */
export const createCoreApi = (
  db: CoreDatabase,
  storage: CoreStorage,
  options: CoreApiOptions = {},
) => {
  const reads = createCoreReads(db, storage);
  return {
    ...reads,
    ...createCoreOperations(
      purgingCachedRoutes(db, options.onCachedRoutesChange),
      options,
    ),
    /** One read, which checks the schema settings first. */
    ready: async (): Promise<void> => {
      await reads.listReleaseCatalogs({ limit: 1 });
    },
  };
};

export type CoreApi = ReturnType<typeof createCoreApi>;

/**
 * Core's API in process, on a database's storage adapter: how the CLI reads
 * and writes a database that runs on the storage engine.
 */
export const createInProcessCoreApi = (
  adapter: DatabaseAdapter,
  options: CoreApiOptions = {},
): CoreApi =>
  createCoreApi(
    createDatabaseEngine({
      adapter,
      schema: resolveSchema([coreModule]),
    }).database(coreModule),
    { resolveFileUrl: async () => null },
    options,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isAdapter = (value: unknown): value is DatabaseAdapter =>
  isRecord(value) &&
  ["fits", "get", "query", "write"].every(
    (method) => typeof value[method] === "function",
  );

/** The storage adapter a configured database runs on, if it is on the engine. */
export const engineAdapterOf = (
  database: unknown,
): DatabaseAdapter | undefined =>
  isRecord(database) && isAdapter(database.adapter)
    ? database.adapter
    : isAdapter(database)
      ? database
      : undefined;

export const OFF_ENGINE_DATABASE =
  "This database does not run on Hot Updater's storage engine. Upgrade its provider package to 1.0.";

/**
 * Core's API for a configured database, as the CLI uses it: a self-hosted
 * server's admin API when the database is `standaloneRepository`, or the
 * database's own storage adapter, in process.
 */
export const createDatabaseCoreApi = (
  database: unknown,
  options: { readonly now?: () => number } = {},
): HotUpdaterCoreApi => {
  if (isRecord(database) && isRecord(database.core)) {
    return database.core as unknown as HotUpdaterCoreApi;
  }
  const adapter = engineAdapterOf(database);
  if (adapter === undefined) throw new Error(OFF_ENGINE_DATABASE);
  const engineDatabase = database as Partial<EngineDatabase>;
  return createInProcessCoreApi(adapter, {
    ...options,
    ...(typeof engineDatabase.onCachedRoutesChange === "function"
      ? { onCachedRoutesChange: () => engineDatabase.onCachedRoutesChange!() }
      : {}),
  });
};
