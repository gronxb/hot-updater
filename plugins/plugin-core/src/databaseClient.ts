import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";

import {
  hydrateRows,
  loadBundleRows,
  responsePage,
  toBundleWhere,
} from "./databaseClientReads";
import {
  DatabasePatchUpdateUnsupportedError,
  bundleUpdateToPatchRows,
  bundleUpdateToRow,
  updateBundle,
} from "./databaseClientUpdates";
import { bundleToPatchRows, bundleToRow } from "./databaseRows";
import {
  attachDatabasePluginAggregateMutations,
  getDatabasePluginAggregateMutations,
} from "./internal/databaseAggregateMutations";
import { bundleMatchesQueryWhere } from "./queryBundles";
import { resolveUpdateInfoFromBundles } from "./resolveUpdateInfoFromBundles";
import type {
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
  DatabasePlugin,
  PaginatedResult,
  TransactionDatabasePlugin,
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
  /**
   * Runs multiple aggregate mutations in one plugin transaction when
   * available. Without transaction support, operations run sequentially and
   * may leave partial state when the callback rejects.
   */
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

const transactionPlugin = (
  database: TransactionDatabasePlugin,
): DatabasePlugin => ({
  name: "transaction",
  ...database,
  transaction: (callback) => callback(database),
});

const transactionlessBatchPlugin = (plugin: DatabasePlugin): DatabasePlugin => {
  const aggregateMutations = getDatabasePluginAggregateMutations(plugin);
  const database = {
    ...plugin,
    onDatabaseUpdated: undefined,
    transaction: undefined,
  };
  return aggregateMutations
    ? attachDatabasePluginAggregateMutations(database, aggregateMutations)
    : database;
};

export const createDatabaseClient = (
  plugin: DatabasePlugin,
): DatabaseClient => {
  const aggregateMutations = getDatabasePluginAggregateMutations(plugin);
  const mutate = async (
    operation: (database: TransactionDatabasePlugin) => Promise<void>,
  ): Promise<void> => {
    if (plugin.transaction) {
      await plugin.transaction(operation);
    } else {
      await operation(plugin);
    }
    await plugin.onDatabaseUpdated?.();
  };

  const getBundleById = async (id: string): Promise<Bundle | null> => {
    const row = await plugin.findOne({
      model: "bundles",
      where: [{ field: "id", value: id }],
    });
    if (!row) return null;
    return (await hydrateRows(plugin, [row]))[0] ?? null;
  };

  const getBundles = (options: DatabaseBundleQueryOptions) =>
    responsePage(plugin, options);

  const mutateBatch = async <TResult>(
    operation: (client: DatabaseMutationClient) => Promise<TResult>,
  ): Promise<TResult> => {
    const run = (database: TransactionDatabasePlugin) =>
      operation(createDatabaseClient(transactionPlugin(database)));
    const result = plugin.transaction
      ? await plugin.transaction(run)
      : await operation(
          createDatabaseClient(transactionlessBatchPlugin(plugin)),
        );
    await plugin.onDatabaseUpdated?.();
    return result;
  };

  const transaction = plugin.transaction;
  const mutateAtomic = transaction
    ? async <TResult>(
        operation: (client: DatabaseMutationClient) => Promise<TResult>,
      ): Promise<TResult> => {
        const result = await transaction((database) =>
          operation(createDatabaseClient(transactionPlugin(database))),
        );
        await plugin.onDatabaseUpdated?.();
        return result;
      }
    : undefined;

  return {
    getBundleById,
    getBundles,
    async getChannels() {
      if (plugin.getChannels) return plugin.getChannels();
      const channels = new Set<string>();
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const rows = await plugin.findMany({
          model: "bundles",
          select: ["channel"],
          limit: PAGE_SIZE,
          offset,
          orderBy: [
            { field: "channel", direction: "asc" },
            { field: "id", direction: "asc" },
          ],
        });
        for (const { channel } of rows) channels.add(channel);
        if (rows.length < PAGE_SIZE) return [...channels].sort();
      }
    },
    async getUpdateInfo(args) {
      if (plugin.getUpdateInfo) {
        return plugin.getUpdateInfo(args);
      }
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
      const rows = await loadBundleRows(plugin, toBundleWhere(where));
      const bundles = (await hydrateRows(plugin, rows)).filter((bundle) =>
        bundleMatchesQueryWhere(bundle, where),
      );
      return resolveUpdateInfoFromBundles({ args, bundles });
    },
    async insertBundle(bundle) {
      const patchRows = bundleToPatchRows(bundle);
      if (patchRows.length > 0 && !plugin.transaction) {
        if (!aggregateMutations) {
          throw new DatabasePatchInsertUnsupportedError(bundle.id, plugin.name);
        }
        await aggregateMutations.insertBundleWithPatches({
          bundle: bundleToRow(bundle),
          patches: patchRows,
        });
        await plugin.onDatabaseUpdated?.();
        return;
      }
      await mutate(async (database) => {
        await database.create({
          model: "bundles",
          data: bundleToRow(bundle),
        });
        for (const patch of patchRows) {
          await database.create({ model: "bundle_patches", data: patch });
        }
      });
    },
    async updateBundleById(bundleId, update) {
      if (Object.hasOwn(update, "patches") && !plugin.transaction) {
        if (!aggregateMutations) {
          throw new DatabasePatchUpdateUnsupportedError(bundleId, plugin.name);
        }
        const updated = await aggregateMutations.updateBundleWithPatches({
          bundleId,
          update: bundleUpdateToRow(update),
          patches: bundleUpdateToPatchRows(bundleId, update),
        });
        if (!updated) throw new DatabaseBundleNotFoundError(bundleId);
        await plugin.onDatabaseUpdated?.();
        return;
      }
      await mutate(async (database) => {
        const updated = await updateBundle(database, bundleId, update);
        if (!updated) throw new DatabaseBundleNotFoundError(bundleId);
      });
    },
    async deleteBundleById(bundleId) {
      await mutate(async (database) => {
        await database.delete({
          model: "bundles",
          where: [{ field: "id", value: bundleId }],
        });
      });
    },
    mutate: mutateBatch,
    ...(mutateAtomic ? { mutateAtomic } : {}),
  };
};
