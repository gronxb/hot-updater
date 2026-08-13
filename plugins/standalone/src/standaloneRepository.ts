import type {
  BundlePatchRow,
  BundleRepository,
  BundleRow,
  DatabaseBundleQueryWhere,
} from "@hot-updater/plugin-core";
import type { DatabaseWhere } from "@hot-updater/plugin-core/internal";

import { createStandaloneBundleRemote } from "./standaloneBundleRemote";
import { createLegacyCompatibilityImplementation } from "./standaloneLegacyImplementation";
import { createStandaloneReleaseRemote } from "./standaloneReleaseRemote";
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
  if (where.platform !== undefined) {
    filters.push({ field: "platform", value: where.platform });
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
  return filters;
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
  const releaseRemote = createStandaloneReleaseRemote(config);
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
      releases: {
        findById: (id) => releaseRemote.findReleaseById(id),
        findMany: (input) => releaseRemote.findReleases(input),
        findManyByScope: (input) => releaseRemote.findReleasesByScope(input),
      },
      releaseCatalogs: {
        findByScopeKey: (scopeKey) =>
          releaseRemote.findCatalogByScopeKey(scopeKey),
        findMany: (input) => releaseRemote.findCatalogs(input),
      },
      channels: {
        insert: (input) => remote.insertChannel(input),
        delete: (input) => remote.deleteChannel(input),
        async list() {
          return { channels: await remote.loadChannels() };
        },
      },
    },
    commit: (input) => releaseRemote.commit(input),
  };
  return Object.freeze(repository);
};
