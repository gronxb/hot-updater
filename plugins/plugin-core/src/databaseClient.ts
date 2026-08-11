import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";

import { DatabaseAtomicCommitUnsupportedError } from "./createDatabasePlugin";
import {
  hydrateRows,
  loadBundleRows,
  responsePage,
} from "./databaseClientReads";
import {
  DatabasePatchUpdateUnsupportedError,
  bundleUpdateToPatchRows,
  bundleUpdateToRow,
} from "./databaseClientUpdates";
import { bundleToPatchRows, bundleToRow } from "./databaseRows";
import { bundleMatchesQueryWhere } from "./queryBundles";
import { resolveUpdateInfoFromBundles } from "./resolveUpdateInfoFromBundles";
import type {
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
  DatabaseCommit,
  DatabaseCommitResult,
  DatabasePlugin,
  PaginatedResult,
} from "./types";

const PAGE_SIZE = 100;

export interface DatabaseClient {
  getBundleById(id: string): Promise<Bundle | null>;
  getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null>;
  getChannels(): Promise<string[]>;
  getBundles(options: DatabaseBundleQueryOptions): Promise<PaginatedResult>;
  insertBundle(bundle: Bundle): Promise<void>;
  updateBundleById(bundleId: string, update: Partial<Bundle>): Promise<void>;
  deleteBundleById(bundleId: string): Promise<void>;
  mutate<TResult>(
    operation: (client: DatabaseMutationClient) => Promise<TResult>,
  ): Promise<TResult>;
  mutateAtomic?<TResult>(
    operation: (client: DatabaseMutationClient) => Promise<TResult>,
  ): Promise<TResult>;
}

export type DatabaseMutationClient = Omit<
  DatabaseClient,
  "mutate" | "mutateAtomic"
>;

export class DatabaseBundleNotFoundError extends Error {
  readonly name = "DatabaseBundleNotFoundError";

  constructor(readonly bundleId: string) {
    super(`Bundle "${bundleId}" was not found.`);
  }
}

export class DatabasePatchInsertUnsupportedError extends Error {
  readonly name = "DatabasePatchInsertUnsupportedError";

  constructor(
    readonly bundleId: string,
    readonly pluginName: string,
  ) {
    super(
      `Database plugin "${pluginName}" cannot atomically insert patches for bundle "${bundleId}".`,
    );
  }
}

export { DatabasePatchUpdateUnsupportedError };

type CommitOperation = (input: DatabaseCommit) => Promise<DatabaseCommitResult>;

const insertCommit = (bundle: Bundle): DatabaseCommit => ({
  operation: "insert",
  bundleId: bundle.id,
  changes: [
    { table: "bundles", operation: "insert", row: bundleToRow(bundle) },
    ...bundleToPatchRows(bundle).map((row) => ({
      table: "bundle_patches" as const,
      operation: "insert" as const,
      row,
    })),
  ],
});

const updateCommit = (
  bundleId: string,
  update: Partial<Bundle>,
): DatabaseCommit => {
  const rowUpdate = bundleUpdateToRow(update);
  const patchesPresent = Object.hasOwn(update, "patches");
  return {
    operation: "update",
    bundleId,
    changes: [
      ...(Object.keys(rowUpdate).length > 0
        ? [
            {
              table: "bundles" as const,
              operation: "update" as const,
              id: bundleId,
              update: rowUpdate,
            },
          ]
        : []),
      ...(patchesPresent
        ? [
            {
              table: "bundle_patches" as const,
              operation: "delete" as const,
              bundleId,
            },
            ...bundleUpdateToPatchRows(bundleId, update).map((row) => ({
              table: "bundle_patches" as const,
              operation: "insert" as const,
              row,
            })),
          ]
        : []),
    ],
  };
};

const deleteCommit = (bundleId: string): DatabaseCommit => ({
  operation: "delete",
  bundleId,
  changes: [{ table: "bundles", operation: "delete", id: bundleId }],
});

export const createDatabaseClient = (
  plugin: DatabasePlugin,
): DatabaseClient => {
  const getBundleById = async (id: string): Promise<Bundle | null> => {
    const row = await plugin.bundles.findById(id);
    if (!row) return null;
    return (await hydrateRows(plugin, [row]))[0] ?? null;
  };

  const createMutationClient = (
    commit: CommitOperation,
  ): DatabaseMutationClient => ({
    getBundleById,
    getBundles: (options) => responsePage(plugin, options),
    async getChannels() {
      if (plugin.getChannels) return plugin.getChannels();
      const channels = new Set<string>();
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const rows = await plugin.bundles.findMany({
          limit: PAGE_SIZE,
          offset,
          orderBy: { field: "id", direction: "asc" },
        });
        for (const { channel } of rows) channels.add(channel);
        if (rows.length < PAGE_SIZE) return [...channels].sort();
      }
    },
    async getUpdateInfo(args) {
      if (plugin.getUpdateInfo) return plugin.getUpdateInfo(args);
      const channel = args.channel ?? "production";
      const minBundleId = args.minBundleId ?? NIL_UUID;
      const where: DatabaseBundleQueryWhere = {
        channel,
        platform: args.platform,
        enabled: true,
        id: { gte: minBundleId },
        ...(args._updateStrategy === "fingerprint"
          ? { fingerprintHash: args.fingerprintHash }
          : { targetAppVersionNotNull: true }),
      };
      const rows = await loadBundleRows(plugin, where);
      const bundles = (await hydrateRows(plugin, rows)).filter((bundle) =>
        bundleMatchesQueryWhere(bundle, where),
      );
      return resolveUpdateInfoFromBundles({ args, bundles });
    },
    async insertBundle(bundle) {
      try {
        await commit(insertCommit(bundle));
      } catch (error) {
        if (
          error instanceof DatabaseAtomicCommitUnsupportedError &&
          bundleToPatchRows(bundle).length > 0
        ) {
          throw new DatabasePatchInsertUnsupportedError(bundle.id, plugin.name);
        }
        throw error;
      }
    },
    async updateBundleById(bundleId, update) {
      try {
        const result = await commit(updateCommit(bundleId, update));
        if (!result.applied) throw new DatabaseBundleNotFoundError(bundleId);
      } catch (error) {
        if (
          error instanceof DatabaseAtomicCommitUnsupportedError &&
          Object.hasOwn(update, "patches")
        ) {
          throw new DatabasePatchUpdateUnsupportedError(bundleId, plugin.name);
        }
        throw error;
      }
    },
    async deleteBundleById(bundleId) {
      await commit(deleteCommit(bundleId));
    },
  });

  const runMutation = async <TResult>(
    operation: (client: DatabaseMutationClient) => Promise<TResult>,
    requireAtomic: boolean,
  ): Promise<TResult> => {
    const commits: DatabaseCommit[] = [];
    const result = await operation(
      createMutationClient(async (input) => {
        commits.push(input);
        return { applied: true };
      }),
    );
    if (commits.length === 0) return result;
    if (plugin.commitBatch) {
      const results = await plugin.commitBatch(commits);
      const missing = results.findIndex(({ applied }) => !applied);
      if (missing >= 0) {
        throw new DatabaseBundleNotFoundError(commits[missing]!.bundleId);
      }
    } else {
      if (requireAtomic && commits.length > 1) {
        throw new DatabaseAtomicCommitUnsupportedError(plugin.name);
      }
      for (const input of commits) {
        const commitResult = await plugin.commit(input);
        if (!commitResult.applied) {
          throw new DatabaseBundleNotFoundError(input.bundleId);
        }
      }
    }
    await plugin.onDatabaseUpdated?.();
    return result;
  };

  const direct = createMutationClient(async (input) => {
    const result = await plugin.commit(input);
    if (result.applied) await plugin.onDatabaseUpdated?.();
    return result;
  });

  return {
    ...direct,
    mutate: (operation) => runMutation(operation, false),
    ...(plugin.commitBatch
      ? { mutateAtomic: (operation) => runMutation(operation, true) }
      : {}),
  };
};
