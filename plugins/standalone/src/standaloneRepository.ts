import type {
  BundlePatchRow,
  BundleRepository,
  BundleRepositoryCommit,
  BundleRow,
  DatabaseBundleQueryWhere,
  DatabaseCommitResult,
} from "@hot-updater/plugin-core";
import { DatabaseAtomicCommitUnsupportedError } from "@hot-updater/plugin-core";
import type { DatabaseWhere } from "@hot-updater/plugin-core/internal";

import { createStandaloneBundleRemote } from "./standaloneBundleRemote";
import { createLegacyCompatibilityImplementation } from "./standaloneLegacyImplementation";
import { runLegacyAggregateTransaction } from "./standaloneLegacyTransaction";
import type { StandaloneRepositoryConfig } from "./standaloneRoutes";

export { StandaloneDatabaseError } from "./standaloneHttp";
export type {
  RouteConfig,
  Routes,
  StandaloneRepositoryConfig,
} from "./standaloneRoutes";

const toBundleWhere = (
  where: DatabaseBundleQueryWhere | undefined,
): readonly DatabaseWhere<"bundles">[] => {
  if (!where) return [];
  const filters: DatabaseWhere<"bundles">[] = [];
  if (where.channel !== undefined) {
    filters.push({ field: "channel", value: where.channel });
  }
  if (where.platform !== undefined) {
    filters.push({ field: "platform", value: where.platform });
  }
  if (where.enabled !== undefined) {
    filters.push({ field: "enabled", value: where.enabled });
  }
  if (where.id?.eq !== undefined) {
    filters.push({ field: "id", value: where.id.eq });
  }
  if (where.id?.gt !== undefined) {
    filters.push({ field: "id", operator: "gt", value: where.id.gt });
  }
  if (where.id?.gte !== undefined) {
    filters.push({ field: "id", operator: "gte", value: where.id.gte });
  }
  if (where.id?.lt !== undefined) {
    filters.push({ field: "id", operator: "lt", value: where.id.lt });
  }
  if (where.id?.lte !== undefined) {
    filters.push({ field: "id", operator: "lte", value: where.id.lte });
  }
  if (where.id?.in !== undefined) {
    filters.push({ field: "id", operator: "in", value: where.id.in });
  }
  if (where.targetAppVersion !== undefined) {
    filters.push({
      field: "target_app_version",
      value: where.targetAppVersion,
    });
  }
  if (where.targetAppVersionNotNull) {
    filters.push({
      field: "target_app_version",
      operator: "ne",
      value: null,
    });
  }
  if (where.targetAppVersionIn !== undefined) {
    filters.push({
      field: "target_app_version",
      operator: "in",
      value: where.targetAppVersionIn,
    });
  }
  if (where.fingerprintHash !== undefined) {
    filters.push({
      field: "fingerprint_hash",
      value: where.fingerprintHash,
    });
  }
  return filters;
};

const applyCommit = async (
  remote: ReturnType<typeof createStandaloneBundleRemote>,
  input: BundleRepositoryCommit,
): Promise<DatabaseCommitResult> => {
  const channelChanges = input.changes.filter(
    (change) => change.model === "channels",
  );
  if (channelChanges.length > 0) {
    if (input.changes.length > 1) {
      throw new DatabaseAtomicCommitUnsupportedError("standalone-repository");
    }
    const [change] = channelChanges;
    if (change !== undefined) {
      if (change.operation === "insert") {
        await remote.insertChannel({
          row: change.row,
          onConflict: "returnExisting",
        });
      } else {
        const result = await remote.deleteChannel({ id: change.where.id });
        if (!result.deleted && result.reason === "not_empty") {
          return {
            committed: false,
            conflict: { changeIndex: 0, reason: "referenced" },
          };
        }
      }
    }
    return { committed: true };
  }

  return runLegacyAggregateTransaction(remote, async (database) => {
    for (const [changeIndex, change] of input.changes.entries()) {
      if (change.model !== "bundles" || change.operation !== "update") {
        continue;
      }
      const row = await database.findOne({
        model: "bundles",
        where: [{ field: "id", value: change.where.id }],
        select: ["id"],
      });
      if (row === null) {
        return {
          committed: false,
          conflict: { changeIndex, reason: "not_found" },
        } as const;
      }
    }

    for (const change of input.changes) {
      if (change.model === "bundles") {
        switch (change.operation) {
          case "insert":
            await database.create({ model: "bundles", data: change.row });
            break;
          case "update":
            await database.update({
              model: "bundles",
              where: [{ field: "id", value: change.where.id }],
              update: change.update,
            });
            break;
          case "delete":
            await database.delete({
              model: "bundles",
              where: [{ field: "id", value: change.where.id }],
            });
            break;
        }
        continue;
      }
      if (change.model !== "bundlePatches") {
        throw new DatabaseAtomicCommitUnsupportedError("standalone-repository");
      }

      switch (change.operation) {
        case "insert":
          await database.create({
            model: "bundle_patches",
            data: change.row,
          });
          break;
        case "delete":
          await database.delete({
            model: "bundle_patches",
            where: [{ field: "bundle_id", value: change.where.bundleId }],
          });
          break;
      }
    }
    return { committed: true };
  });
};

/**
 * Bundle-only HTTP repository used by the CLI for a self-hosted server.
 *
 * This is intentionally not a database plugin: analytics and access-key
 * persistence belong to the server's database provider.
 */
export const standaloneRepository = (
  config: StandaloneRepositoryConfig,
): BundleRepository => {
  const remote = createStandaloneBundleRemote(config);
  const database = createLegacyCompatibilityImplementation(remote);

  const repository: BundleRepository = {
    name: "standalone-repository",
    models: {
      bundles: {
        async findById(id): Promise<BundleRow | null> {
          return (await database.findOne({
            model: "bundles",
            where: [{ field: "id", value: id }],
          })) as BundleRow | null;
        },
        async findMany(query): Promise<readonly BundleRow[]> {
          return (await database.findMany({
            model: "bundles",
            where: toBundleWhere(query.where),
            limit: query.limit,
            offset: query.offset,
            orderBy: [query.orderBy],
          })) as readonly BundleRow[];
        },
        count: (where) =>
          database.count({ model: "bundles", where: toBundleWhere(where) }),
      },
      bundlePatches: {
        async findByBundleIds(bundleIds): Promise<readonly BundlePatchRow[]> {
          if (bundleIds.length === 0) return [];
          return (await database.findMany({
            model: "bundle_patches",
            where: [{ field: "bundle_id", operator: "in", value: bundleIds }],
            orderBy: [{ field: "id", direction: "asc" }],
            limit: Number.MAX_SAFE_INTEGER,
            offset: 0,
          })) as readonly BundlePatchRow[];
        },
      },
      channels: {
        insert: (input) => remote.insertChannel(input),
        delete: (input) => remote.deleteChannel(input),
        async list() {
          return { channels: await remote.loadChannels() };
        },
      },
    },
    queries: {},
    commit: (input) => applyCommit(remote, input),
  };
  return Object.freeze(repository);
};
