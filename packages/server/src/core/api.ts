import { createCoreOperations } from "./operations";
import { createCoreReads, type CoreDatabase, type CoreStorage } from "./reads";

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
