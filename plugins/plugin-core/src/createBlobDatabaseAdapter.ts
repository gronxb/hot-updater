import {
  createBlobSnapshotCrud,
  type BlobSnapshotState,
} from "./blobDatabaseCrud";
import { changedBundleInvalidationPaths } from "./blobDatabaseInvalidation";
import { parseLegacyBundle } from "./blobDatabaseLegacy";
import {
  BLOB_DATABASE_BACKUP_KEY,
  BLOB_DATABASE_SNAPSHOT_KEY,
  emptyBlobDatabaseSnapshot,
  parseBlobDatabaseSnapshot,
  type BlobDatabaseSnapshot,
} from "./blobDatabaseSnapshot";
import { createDatabasePlugin } from "./createDatabasePlugin";
import { rowsToBundles } from "./databaseRows";
import { resolveUpdateInfoFromBundles } from "./resolveUpdateInfoFromBundles";
import type {
  DatabasePluginLifecycleHooks,
  DatabasePluginImplementation,
  TransactionDatabasePluginImplementation,
} from "./types";

export {
  BLOB_DATABASE_BACKUP_KEY,
  BLOB_DATABASE_SNAPSHOT_KEY,
  type BlobDatabaseSnapshot,
} from "./blobDatabaseSnapshot";
export { BlobDatabaseSnapshotError } from "./blobDatabaseErrors";

export interface BlobDatabaseOperations {
  readonly apiBasePath: string;
  readonly listObjects: (prefix: string) => Promise<readonly string[]>;
  readonly loadObject: (key: string) => Promise<unknown | null>;
  readonly uploadObject: (key: string, data: unknown) => Promise<void>;
  readonly invalidatePaths: (paths: readonly string[]) => Promise<void>;
  readonly shouldSkipLoadObjectError?: (error: unknown, key: string) => boolean;
}

export class BlobDatabaseWriteConflictError extends Error {
  readonly name = "BlobDatabaseWriteConflictError";

  constructor() {
    super("Blob database snapshot changed while a mutation was in progress.");
  }
}

type SnapshotMutation<TResult> = (
  implementation: TransactionDatabasePluginImplementation,
) => Promise<TResult>;

const loadOptionalObject = async (
  operations: BlobDatabaseOperations,
  key: string,
): Promise<unknown | null> => {
  try {
    return await operations.loadObject(key);
  } catch (error) {
    if (operations.shouldSkipLoadObjectError?.(error, key)) return null;
    throw error;
  }
};

const loadLegacySnapshot = async (
  operations: BlobDatabaseOperations,
): Promise<BlobDatabaseSnapshot> => {
  const keys = (await operations.listObjects(""))
    .filter((key) => key.endsWith("/update.json"))
    .sort((left, right) => left.localeCompare(right));
  const bundles = new Map<string, BlobDatabaseSnapshot["bundles"][number]>();
  const patches = new Map<
    string,
    BlobDatabaseSnapshot["bundle_patches"][number]
  >();
  const channels = new Map<string, BlobDatabaseSnapshot["channels"][number]>();
  for (const key of keys) {
    const value = await loadOptionalObject(operations, key);
    if (value === null) continue;
    if (!Array.isArray(value)) {
      parseLegacyBundle(value, key);
      continue;
    }
    for (const item of value) {
      const parsed = parseLegacyBundle(item, key);
      const channel = channels.get(parsed.channelName) ?? {
        id: parsed.channelName,
        name: parsed.channelName,
      };
      channels.set(channel.name, channel);
      bundles.set(parsed.bundle.id, {
        ...parsed.bundle,
        channel_id: channel.id,
      });
      for (const [patchId, patch] of patches) {
        if (patch.bundle_id === parsed.bundle.id) patches.delete(patchId);
      }
      for (const patch of parsed.patches) patches.set(patch.id, patch);
    }
  }
  return parseBlobDatabaseSnapshot(
    {
      version: 2,
      bundles: [...bundles.values()],
      bundle_patches: [...patches.values()],
      channels: [...channels.values()],
    },
    "legacy update.json manifests",
  );
};

export const createBlobDatabaseAdapter = <TConfig, TContext = unknown>({
  name,
  factory,
}: {
  readonly name: string;
  readonly factory: (config: TConfig) => BlobDatabaseOperations;
}) => {
  return (config: TConfig, hooks?: DatabasePluginLifecycleHooks) => {
    const operations = factory(config);
    let mutationQueue: Promise<void> = Promise.resolve();

    const loadSnapshot = async (): Promise<BlobDatabaseSnapshot> => {
      const stored = await loadOptionalObject(
        operations,
        BLOB_DATABASE_SNAPSHOT_KEY,
      );
      if (stored !== null) return parseBlobDatabaseSnapshot(stored);
      const legacy = await loadLegacySnapshot(operations);
      if (legacy.bundles.length > 0) {
        await operations.uploadObject(BLOB_DATABASE_SNAPSHOT_KEY, legacy);
      }
      return legacy;
    };

    const persistSnapshot = async (
      before: BlobDatabaseSnapshot,
      after: BlobDatabaseSnapshot,
    ): Promise<void> => {
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      const current = await loadOptionalObject(
        operations,
        BLOB_DATABASE_SNAPSHOT_KEY,
      );
      const currentSnapshot =
        current === null
          ? emptyBlobDatabaseSnapshot()
          : parseBlobDatabaseSnapshot(current);
      if (JSON.stringify(currentSnapshot) !== JSON.stringify(before)) {
        throw new BlobDatabaseWriteConflictError();
      }
      if (current !== null) {
        await operations.uploadObject(
          BLOB_DATABASE_BACKUP_KEY,
          currentSnapshot,
        );
      }
      await operations.uploadObject(BLOB_DATABASE_SNAPSHOT_KEY, after);
      const paths = changedBundleInvalidationPaths(
        operations.apiBasePath,
        before,
        after,
      );
      if (paths.length > 0) await operations.invalidatePaths(paths);
    };

    const mutate = <TResult>(
      mutation: SnapshotMutation<TResult>,
    ): Promise<TResult> => {
      const run = mutationQueue.then(async () => {
        const before = await loadSnapshot();
        const state: BlobSnapshotState = { snapshot: before };
        const result = await mutation(createBlobSnapshotCrud(state));
        await persistSnapshot(before, state.snapshot);
        return result;
      });
      mutationQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    const read = async <TResult>(
      query: SnapshotMutation<TResult>,
    ): Promise<TResult> => {
      await mutationQueue;
      const state: BlobSnapshotState = { snapshot: await loadSnapshot() };
      return query(createBlobSnapshotCrud(state));
    };

    const implementation: DatabasePluginImplementation<TContext> = {
      create: (input) => mutate((database) => database.create(input)),
      update: (input) => mutate((database) => database.update(input)),
      delete: (input) => mutate((database) => database.delete(input)),
      count: (input) => read((database) => database.count(input)),
      findOne: (input) => read((database) => database.findOne(input)),
      findMany: (input) => read((database) => database.findMany(input)),
      getUpdateInfo: async (args, context) => {
        await mutationQueue;
        const snapshot = await loadSnapshot();
        return resolveUpdateInfoFromBundles({
          args,
          bundles: rowsToBundles(
            snapshot.bundles,
            snapshot.bundle_patches,
            snapshot.bundles,
            snapshot.channels,
          ),
          context,
        });
      },
      transaction: (callback) => mutate(callback),
    };

    return createDatabasePlugin<TConfig, TContext>({
      name,
      factory: () => implementation,
    })(config, hooks);
  };
};
