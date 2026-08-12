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
  BundleRepository,
  BundleRepositoryChange,
  ChannelDeleteInput,
  ChannelDeleteResult,
  ChannelInsertInput,
  ChannelInsertResult,
  ChannelRow,
  DatabaseBundleQueryOptions,
  DatabaseBundleQueryWhere,
  DatabaseCommitResult,
  PaginatedResult,
} from "./types";
import { createUUIDv7 } from "./uuidv7";

export interface DatabaseClient {
  getBundleById(id: string): Promise<Bundle | null>;
  getUpdateInfo(args: GetBundlesArgs): Promise<UpdateInfo | null>;
  getChannels(): Promise<readonly ChannelRow[]>;
  insertChannel(input: ChannelInsertInput): Promise<ChannelInsertResult>;
  deleteChannel(input: ChannelDeleteInput): Promise<ChannelDeleteResult>;
  getBundles(options: DatabaseBundleQueryOptions): Promise<PaginatedResult>;
  insertBundle(bundle: Bundle): Promise<void>;
  updateBundleById(bundleId: string, update: Partial<Bundle>): Promise<void>;
  deleteBundleById(bundleId: string): Promise<void>;
  mutate<TResult>(
    operation: (client: DatabaseMutationClient) => Promise<TResult>,
  ): Promise<TResult>;
}

export type DatabaseMutationClient = Omit<
  DatabaseClient,
  "deleteChannel" | "mutate"
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

type BundleMutationChange = Extract<
  BundleRepositoryChange,
  { readonly model: "bundles" | "bundlePatches" }
>;

type CommitOperation = (
  changes: readonly BundleMutationChange[],
) => Promise<DatabaseCommitResult>;

const insertChanges = (
  bundle: Bundle,
  channel: ChannelRow,
): readonly BundleMutationChange[] => [
  {
    model: "bundles",
    operation: "insert",
    row: bundleToRow(bundle, channel.id),
  },
  ...bundleToPatchRows(bundle).map((row) => ({
    model: "bundlePatches" as const,
    operation: "insert" as const,
    row,
  })),
];

const updateChanges = (
  bundleId: string,
  update: Partial<Bundle>,
  channel: ChannelRow | undefined,
): readonly BundleMutationChange[] => {
  const rowUpdate = bundleUpdateToRow(update, channel?.id);
  const patchesPresent = Object.hasOwn(update, "patches");
  return [
    {
      model: "bundles",
      operation: "update",
      where: { id: bundleId },
      update: rowUpdate,
    },
    ...(patchesPresent
      ? [
          {
            model: "bundlePatches" as const,
            operation: "delete" as const,
            where: { bundleId },
          },
          ...bundleUpdateToPatchRows(bundleId, update).map((row) => ({
            model: "bundlePatches" as const,
            operation: "insert" as const,
            row,
          })),
        ]
      : []),
  ];
};

const deleteChanges = (bundleId: string): readonly BundleMutationChange[] => [
  { model: "bundles", operation: "delete", where: { id: bundleId } },
];

export const createDatabaseClient = (
  plugin: BundleRepository,
): DatabaseClient => {
  const getBundleById = async (id: string): Promise<Bundle | null> => {
    const row = await plugin.models.bundles.findById(id);
    if (!row) return null;
    return (await hydrateRows(plugin, [row]))[0] ?? null;
  };

  const insertChannel = (input: ChannelInsertInput) =>
    plugin.models.channels.insert(input);

  const resolveChannel = (name: string): Promise<ChannelInsertResult> =>
    insertChannel({
      row: { id: createUUIDv7(), name },
      onConflict: "returnExisting",
    });

  const createMutationClient = (
    commit: CommitOperation,
  ): DatabaseMutationClient => ({
    getBundleById,
    getBundles: (options) => responsePage(plugin, options),
    async getChannels() {
      return (await plugin.models.channels.list({})).channels;
    },
    insertChannel,
    async getUpdateInfo(args) {
      if (plugin.queries.getUpdateInfo) {
        return plugin.queries.getUpdateInfo(args);
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
      const rows = await loadBundleRows(plugin, where);
      const bundles = (await hydrateRows(plugin, rows)).filter((bundle) =>
        bundleMatchesQueryWhere(bundle, where),
      );
      return resolveUpdateInfoFromBundles({ args, bundles });
    },
    async insertBundle(bundle) {
      const { row: channel } = await resolveChannel(bundle.channel);
      try {
        await commit(insertChanges(bundle, channel));
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
      const channel =
        update.channel === undefined
          ? undefined
          : (await resolveChannel(update.channel)).row;
      try {
        const result = await commit(updateChanges(bundleId, update, channel));
        if (!result.committed) {
          throw new DatabaseBundleNotFoundError(bundleId);
        }
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
      await commit(deleteChanges(bundleId));
    },
  });

  const runMutation = async <TResult>(
    operation: (client: DatabaseMutationClient) => Promise<TResult>,
  ): Promise<TResult> => {
    const changes: BundleMutationChange[] = [];
    const result = await operation(
      createMutationClient(async (input) => {
        changes.push(...input);
        return { committed: true };
      }),
    );
    if (changes.length === 0) return result;
    const commitResult = await plugin.commit({ changes });
    if (!commitResult.committed) {
      const change = changes[commitResult.conflict.changeIndex];
      if (change?.model === "bundles" && change.operation === "update") {
        throw new DatabaseBundleNotFoundError(change.where.id);
      }
      throw new Error(`Database plugin "${plugin.name}" rejected a commit.`);
    }
    return result;
  };

  const direct = createMutationClient((changes) => plugin.commit({ changes }));

  return {
    ...direct,
    deleteChannel: (input) => plugin.models.channels.delete(input),
    mutate: runMutation,
  };
};
