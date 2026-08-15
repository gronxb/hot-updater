import {
  createBlobSnapshotCrud,
  type BlobSnapshotState,
} from "./blobDatabaseCrud";
import { BlobDatabaseSnapshotError } from "./blobDatabaseErrors";
import {
  invalidateBlobPathsAfterCommit,
  type BlobInvalidationFailure,
} from "./blobDatabaseInvalidationRetry";
import { parseLegacyBundle } from "./blobDatabaseLegacy";
import {
  assertBlobUpdateRouteArgs,
  createBlobUpdateManifestObjects,
  loadBlobUpdateBundles,
} from "./blobDatabaseManifests";
import {
  blobDatabaseRevisionManifestPrefix,
  blobDatabaseRevisionSnapshotKey,
  assertBlobDatabasePointerCompatible,
  createBlobDatabasePointer,
  isBlobDatabasePointer,
  parseBlobDatabasePointer,
  readBlobDatabaseRoot,
} from "./blobDatabaseRevision";
import {
  BLOB_DATABASE_BACKUP_KEY,
  BLOB_DATABASE_SNAPSHOT_KEY,
  assertBlobDatabaseSnapshotCompatible,
  parseBlobDatabaseSnapshot,
  type BlobDatabaseSnapshot,
} from "./blobDatabaseSnapshot";
import { blobArray } from "./blobDatabaseValue";
import {
  createDatabasePlugin,
  createDatabasePluginAdapter,
} from "./createDatabasePlugin";
import { resolveUpdateInfoFromBundles } from "./resolveUpdateInfoFromBundles";
import type {
  ChannelRow,
  DatabasePluginImplementation,
  TransactionDatabasePluginImplementation,
} from "./types/internal";
import { createUUIDv7 } from "./uuidv7";

export {
  BLOB_DATABASE_BACKUP_KEY,
  BLOB_DATABASE_SNAPSHOT_KEY,
  type BlobDatabaseSnapshot,
} from "./blobDatabaseSnapshot";
export { BlobDatabaseSnapshotError } from "./blobDatabaseErrors";
export type { BlobInvalidationFailure } from "./blobDatabaseInvalidationRetry";

/**
 * @deprecated Blob-backed database plugins will be removed in a future major
 * release. Use `createDatabasePlugin` with a row-oriented implementation.
 */
export interface BlobDatabaseOperations {
  readonly apiBasePath: string;
  readonly listObjects: (prefix: string) => Promise<readonly string[]>;
  readonly listLegacyUpdateManifests?: () => Promise<readonly string[]>;
  readonly loadObject: (key: string) => Promise<unknown | null>;
  readonly uploadObject: (key: string, data: unknown) => Promise<void>;
  readonly compareAndSwapObject: (
    key: string,
    expected: unknown | null,
    data: unknown,
  ) => Promise<boolean>;
  readonly invalidatePaths: (paths: readonly string[]) => Promise<void>;
  readonly onInvalidationError?: (
    failure: BlobInvalidationFailure,
  ) => void | Promise<void>;
  readonly shouldSkipLoadObjectError?: (error: unknown, key: string) => boolean;
  readonly dispose?: () => Promise<void>;
}

/**
 * @deprecated Blob-backed database plugins will be removed in a future major
 * release. Use `createDatabasePlugin` with a row-oriented implementation.
 */
export class BlobDatabaseWriteConflictError extends Error {
  readonly name = "BlobDatabaseWriteConflictError";

  constructor() {
    super("Blob database snapshot changed while a mutation was in progress.");
  }
}

type SnapshotMutation<TResult> = (
  implementation: TransactionDatabasePluginImplementation,
) => Promise<TResult>;

type LoadedBlobDatabaseSnapshot = {
  readonly raw: unknown | null;
  readonly snapshot: BlobDatabaseSnapshot;
};

type BlobDatabaseRow = {
  readonly id: string;
};

const BLOB_DATABASE_COMMIT_MAX_ATTEMPTS = 16;
const BLOB_DATABASE_COMMIT_RETRY_BASE_DELAY_MS = 10;

const rowsEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const mergeChangedRows = <TRow extends BlobDatabaseRow>(
  baseRows: readonly TRow[],
  intendedRows: readonly TRow[],
  latestRows: readonly TRow[],
): readonly TRow[] => {
  const base = new Map(baseRows.map((row) => [row.id, row]));
  const intended = new Map(intendedRows.map((row) => [row.id, row]));
  const merged = new Map(latestRows.map((row) => [row.id, row]));
  const candidateIds = new Set([...base.keys(), ...intended.keys()]);

  for (const id of candidateIds) {
    const baseRow = base.get(id);
    const intendedRow = intended.get(id);
    if (rowsEqual(baseRow, intendedRow)) continue;

    const latestRow = merged.get(id);
    if (rowsEqual(latestRow, intendedRow)) continue;
    if (!rowsEqual(latestRow, baseRow)) {
      throw new BlobDatabaseWriteConflictError();
    }

    if (intendedRow) {
      merged.set(id, intendedRow);
    } else {
      merged.delete(id);
    }
  }

  return [...merged.values()];
};

const mergeSnapshotMutation = (
  base: BlobDatabaseSnapshot,
  intended: BlobDatabaseSnapshot,
  latest: BlobDatabaseSnapshot,
): BlobDatabaseSnapshot => {
  try {
    assertBlobDatabaseSnapshotCompatible(base);
    assertBlobDatabaseSnapshotCompatible(latest);
    return parseBlobDatabaseSnapshot(
      {
        version: 2,
        bundles: mergeChangedRows(
          base.bundles,
          intended.bundles,
          latest.bundles,
        ),
        bundle_patches: mergeChangedRows(
          base.bundle_patches,
          intended.bundle_patches,
          latest.bundle_patches,
        ),
        channels: mergeChangedRows(
          base.channels,
          intended.channels,
          latest.channels,
        ),
        bundle_events: mergeChangedRows(
          base.bundle_events,
          intended.bundle_events,
          latest.bundle_events,
        ),
        client_access_keys: mergeChangedRows(
          base.client_access_keys,
          intended.client_access_keys,
          latest.client_access_keys,
        ),
      },
      "merged concurrent blob database snapshot",
    );
  } catch (error) {
    if (error instanceof BlobDatabaseSnapshotError) {
      throw new BlobDatabaseWriteConflictError();
    }
    throw error;
  }
};

const waitForCommitRetry = (attempt: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(
      resolve,
      Math.min(BLOB_DATABASE_COMMIT_RETRY_BASE_DELAY_MS * attempt, 100),
    );
  });

const isLegacyUpdateManifestKey = (key: string): boolean =>
  /^[^/]+\/(ios|android)\/[^/]+\/update\.json$/.test(key);

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
  const listedObjects = operations.listLegacyUpdateManifests
    ? await operations.listLegacyUpdateManifests()
    : await operations.listObjects("");
  const keys = listedObjects
    .filter(isLegacyUpdateManifestKey)
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
    for (const item of blobArray(value, key)) {
      const parsed = parseLegacyBundle(item, key);
      bundles.set(parsed.bundle.id, parsed.bundle);
      channels.set(parsed.bundle.channel_id, {
        id: parsed.bundle.channel_id,
        name: parsed.channelName,
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
      bundle_events: [],
      client_access_keys: [],
    },
    "legacy update.json manifests",
  );
};

/**
 * @deprecated Blob-backed database plugins will be removed in a future major
 * release. Use `createDatabasePlugin` with a row-oriented implementation.
 */
export const createBlobDatabasePlugin = ({
  name,
  plugin,
}: {
  readonly name: string;
  readonly plugin: () => BlobDatabaseOperations;
}) => {
  const operations = plugin();
  let mutationQueue: Promise<void> = Promise.resolve();

  const stageRevisionObject = async (
    key: string,
    value: unknown,
  ): Promise<void> => {
    const created = await operations.compareAndSwapObject(key, null, value);
    if (!created) throw new BlobDatabaseWriteConflictError();
  };

  const prepareRevision = async (
    snapshot: BlobDatabaseSnapshot,
  ): Promise<ReturnType<typeof createBlobDatabasePointer>> => {
    const revision = createUUIDv7();
    const manifestPrefix = blobDatabaseRevisionManifestPrefix(revision);
    const manifests = createBlobUpdateManifestObjects(snapshot);
    await stageRevisionObject(
      blobDatabaseRevisionSnapshotKey(revision),
      snapshot,
    );
    await Promise.all(
      [...manifests].map(([key, value]) =>
        stageRevisionObject(`${manifestPrefix}/${key}`, value),
      ),
    );
    return createBlobDatabasePointer(revision);
  };

  const loadSnapshot = async (): Promise<LoadedBlobDatabaseSnapshot> => {
    const stored = await loadOptionalObject(
      operations,
      BLOB_DATABASE_SNAPSHOT_KEY,
    );
    if (stored !== null) {
      const root = readBlobDatabaseRoot(stored);
      if (root.kind === "snapshot") {
        assertBlobDatabaseSnapshotCompatible(root.snapshot);
        return { raw: stored, snapshot: root.snapshot };
      }
      assertBlobDatabasePointerCompatible(root.pointer);
      const snapshotKey = blobDatabaseRevisionSnapshotKey(
        root.pointer.active_revision,
      );
      const revisionSnapshot = await loadOptionalObject(
        operations,
        snapshotKey,
      );
      if (revisionSnapshot === null) {
        throw new BlobDatabaseSnapshotError(snapshotKey);
      }
      const snapshot = parseBlobDatabaseSnapshot(revisionSnapshot, snapshotKey);
      assertBlobDatabaseSnapshotCompatible(snapshot);
      return {
        raw: stored,
        snapshot,
      };
    }
    const legacy = await loadLegacySnapshot(operations);
    if (legacy.bundles.length > 0) {
      const pointer = await prepareRevision(legacy);
      const created = await operations.compareAndSwapObject(
        BLOB_DATABASE_SNAPSHOT_KEY,
        null,
        pointer,
      );
      if (!created) return loadSnapshot();
      return { raw: pointer, snapshot: legacy };
    }
    return { raw: null, snapshot: legacy };
  };

  const persistSnapshot = async (
    before: LoadedBlobDatabaseSnapshot,
    after: BlobDatabaseSnapshot,
  ): Promise<void> => {
    assertBlobDatabaseSnapshotCompatible(before.snapshot);
    assertBlobDatabaseSnapshotCompatible(after);
    if (JSON.stringify(before.snapshot) === JSON.stringify(after)) return;
    if (before.raw !== null && isBlobDatabasePointer(before.raw)) {
      assertBlobDatabasePointerCompatible(parseBlobDatabasePointer(before.raw));
    }
    const pointer = await prepareRevision(after);
    if (before.raw !== null && !isBlobDatabasePointer(before.raw)) {
      await operations.uploadObject(BLOB_DATABASE_BACKUP_KEY, before.snapshot);
    }
    const written = await operations.compareAndSwapObject(
      BLOB_DATABASE_SNAPSHOT_KEY,
      before.raw,
      pointer,
    );
    if (!written) throw new BlobDatabaseWriteConflictError();
    await invalidateBlobPathsAfterCommit(operations, before.snapshot, after);
  };

  const mutate = <TResult>(
    mutation: SnapshotMutation<TResult>,
  ): Promise<TResult> => {
    const run = mutationQueue.then(async () => {
      const before = await loadSnapshot();
      const state: BlobSnapshotState = { snapshot: before.snapshot };
      const result = await mutation(createBlobSnapshotCrud(state));
      const intended = state.snapshot;
      let latest = before;
      let merged = intended;

      for (
        let attempt = 1;
        attempt <= BLOB_DATABASE_COMMIT_MAX_ATTEMPTS;
        attempt += 1
      ) {
        try {
          await persistSnapshot(latest, merged);
          return result;
        } catch (error) {
          if (
            !(error instanceof BlobDatabaseWriteConflictError) ||
            attempt === BLOB_DATABASE_COMMIT_MAX_ATTEMPTS
          ) {
            throw error;
          }
        }

        await waitForCommitRetry(attempt);
        latest = await loadSnapshot();
        merged = mergeSnapshotMutation(
          before.snapshot,
          intended,
          latest.snapshot,
        );
      }

      throw new BlobDatabaseWriteConflictError();
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
    const state: BlobSnapshotState = {
      snapshot: (await loadSnapshot()).snapshot,
    };
    return query(createBlobSnapshotCrud(state));
  };

  const insertChannel: DatabasePluginImplementation["insertChannel"] = (
    input,
  ) => {
    const run = mutationQueue.then(async () => {
      for (
        let attempt = 1;
        attempt <= BLOB_DATABASE_COMMIT_MAX_ATTEMPTS;
        attempt += 1
      ) {
        const before = await loadSnapshot();
        const existing = before.snapshot.channels.find(
          ({ name }) => name === input.row.name,
        );
        if (existing) return { row: existing, inserted: false };

        const state: BlobSnapshotState = { snapshot: before.snapshot };
        const row = (await createBlobSnapshotCrud(state).create({
          model: "channels",
          data: input.row,
        })) as ChannelRow;
        try {
          await persistSnapshot(before, state.snapshot);
          return { row, inserted: true };
        } catch (error) {
          if (
            !(error instanceof BlobDatabaseWriteConflictError) ||
            attempt === BLOB_DATABASE_COMMIT_MAX_ATTEMPTS
          ) {
            throw error;
          }
        }
        await waitForCommitRetry(attempt);
      }
      throw new BlobDatabaseWriteConflictError();
    });
    mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const deleteChannel: DatabasePluginImplementation["deleteChannel"] = ({
    id,
  }) => {
    const run = mutationQueue.then(async () => {
      for (
        let attempt = 1;
        attempt <= BLOB_DATABASE_COMMIT_MAX_ATTEMPTS;
        attempt += 1
      ) {
        const before = await loadSnapshot();
        if (!before.snapshot.channels.some((channel) => channel.id === id)) {
          return { deleted: false, reason: "not_found" } as const;
        }
        if (
          before.snapshot.bundles.some(({ channel_id }) => channel_id === id)
        ) {
          return { deleted: false, reason: "not_empty" } as const;
        }

        const state: BlobSnapshotState = { snapshot: before.snapshot };
        await createBlobSnapshotCrud(state).delete({
          model: "channels",
          where: [{ field: "id", value: id }],
        });
        try {
          await persistSnapshot(before, state.snapshot);
          return { deleted: true } as const;
        } catch (error) {
          if (
            !(error instanceof BlobDatabaseWriteConflictError) ||
            attempt === BLOB_DATABASE_COMMIT_MAX_ATTEMPTS
          ) {
            throw error;
          }
        }
        await waitForCommitRetry(attempt);
      }
      throw new BlobDatabaseWriteConflictError();
    });
    mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const implementation: DatabasePluginImplementation = {
    create: (input) => mutate((database) => database.create(input)),
    update: (input) => mutate((database) => database.update(input)),
    delete: (input) => mutate((database) => database.delete(input)),
    count: (input) => read((database) => database.count(input)),
    findOne: (input) => read((database) => database.findOne(input)),
    findMany: (input) => read((database) => database.findMany(input)),
    insertChannel,
    deleteChannel,
    getUpdateInfo: async (args) => {
      assertBlobUpdateRouteArgs(args);
      await mutationQueue;
      const stored = await loadOptionalObject(
        operations,
        BLOB_DATABASE_SNAPSHOT_KEY,
      );
      let manifestPrefix: string | undefined;
      let activeSnapshot: BlobDatabaseSnapshot | undefined;
      if (stored !== null) {
        if (isBlobDatabasePointer(stored)) {
          const root = readBlobDatabaseRoot(stored);
          if (root.kind !== "pointer") {
            throw new BlobDatabaseWriteConflictError();
          }
          assertBlobDatabasePointerCompatible(root.pointer);
          const snapshotKey = blobDatabaseRevisionSnapshotKey(
            root.pointer.active_revision,
          );
          const revisionSnapshot = await loadOptionalObject(
            operations,
            snapshotKey,
          );
          if (revisionSnapshot === null) {
            throw new BlobDatabaseSnapshotError(snapshotKey);
          }
          const snapshot = parseBlobDatabaseSnapshot(
            revisionSnapshot,
            snapshotKey,
          );
          assertBlobDatabaseSnapshotCompatible(snapshot);
          activeSnapshot = snapshot;
          manifestPrefix = blobDatabaseRevisionManifestPrefix(
            root.pointer.active_revision,
          );
        } else {
          const snapshot = parseBlobDatabaseSnapshot(stored);
          assertBlobDatabaseSnapshotCompatible(snapshot);
        }
      }
      return resolveUpdateInfoFromBundles({
        args,
        bundles: await loadBlobUpdateBundles(
          {
            loadObject: (key) => loadOptionalObject(operations, key),
          },
          args,
          manifestPrefix,
          activeSnapshot,
        ),
      });
    },
    transaction: (callback) => mutate(callback),
    ...(operations.dispose ? { dispose: operations.dispose } : {}),
  };

  const adapter = createDatabasePluginAdapter(name, implementation);
  return createDatabasePlugin({
    name,
    models: adapter.models,
    queries: adapter.queries,
    commit: adapter.commit,
    ...(adapter.dispose ? { dispose: adapter.dispose } : {}),
  });
};
