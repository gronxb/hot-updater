import {
  readReleaseCatalogState,
  type ReleaseCatalogHead,
  type ReleaseCatalogState,
} from "./catalogReads";
import {
  enableReleaseCatalogPartitioning,
  issueReleaseCatalogPartitioningToken,
  readReleaseCatalogPartitioning,
} from "./catalogPartitioning";
import type { CatalogWriteOptions } from "./catalogWrites";
import { createIosDeviceApi } from "./iosDevices";
import { createNativeBuildApi } from "./nativeBuilds";
import { createCoreOperations } from "./operations";
import { createCoreReads, type CoreDatabase, type CoreStorage } from "./reads";

export interface CoreApiOptions {
  readonly now?: () => number;
  /** How a staged release catalog publication waits before it restarts. */
  readonly catalogWrites?: CatalogWriteOptions;
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
  const now = options.now ?? Date.now;
  return {
    ...reads,
    ...createCoreOperations(
      purgingCachedRoutes(db, options.onCachedRoutesChange),
      options,
    ),
    ...createNativeBuildApi(db, options),
    ...createIosDeviceApi(db, options),
    /**
     * The update check's read, for the client routes' memo only: a scope's
     * row, and the row covering `appVersion` when it is a head; with
     * `cached`, under the head the memo holds. Not on the public `CoreApi`.
     */
    readReleaseCatalogState: (
      scopeKey: string,
      appVersion: string,
      cached?: ReleaseCatalogHead,
    ): Promise<ReleaseCatalogState> =>
      readReleaseCatalogState(db, scopeKey, appVersion, cached),
    /** The partitioning switch, and whether the server reads the table. */
    getReleaseCatalogPartitioning: () => readReleaseCatalogPartitioning(db),
    /**
     * For tooling that holds the server's database, such as the CLI over a
     * managed provider's: stores a single-use request token's hash for ten
     * minutes, and returns the token, which the server's client route
     * `POST /release-catalog-partitioning` takes to turn partitioning on.
     * It turns nothing on itself.
     */
    issueReleaseCatalogPartitioningToken: () =>
      issueReleaseCatalogPartitioningToken(db, now),
    /**
     * Checks the partitions table with this process's credentials and sets
     * the switch: for the server's routes only. `createHotUpdater` leaves it
     * off the `core` it exposes, so no in-process caller turns it on.
     */
    enableReleaseCatalogPartitioning: (input?: { readonly token?: string }) =>
      enableReleaseCatalogPartitioning(db, now, input),
    /**
     * One raw limit-1 read of the catalog table, which checks the schema
     * settings first and never assembles a partitioned scope.
     */
    ready: async (): Promise<void> => {
      await db.findMany("release_catalogs", {
        index: "all",
        where: {},
        limit: 1,
      });
    },
  };
};

/** Core's API as the server and its handlers hold it, internal reads included. */
export type ServerCoreApi = ReturnType<typeof createCoreApi>;

/** Core's API as `createHotUpdater` exposes it. */
export type CoreApi = Omit<
  ServerCoreApi,
  "readReleaseCatalogState" | "enableReleaseCatalogPartitioning"
>;

/**
 * Core's API without the server-only enable, which only the server's
 * routes call: what `createHotUpdater` hands tooling.
 */
export const publicCoreApi = (core: ServerCoreApi): CoreApi => {
  const { enableReleaseCatalogPartitioning: _enable, ...rest } = core;
  return rest;
};
