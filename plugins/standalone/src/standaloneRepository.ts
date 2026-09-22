import type { BundleRepository } from "@hot-updater/plugin-core";

import { createStandaloneBundleRemote } from "./standaloneBundleRemote";
import { createStandaloneReleaseRemote } from "./standaloneReleaseRemote";
import type { StandaloneRepositoryConfig } from "./standaloneRoutes";

export { StandaloneDatabaseError } from "./standaloneHttp";
export type {
  RouteConfig,
  Routes,
  StandaloneRepositoryConfig,
} from "./standaloneRoutes";

/**
 * Bundle-only HTTP repository used by the CLI for a self-hosted server.
 *
 * This is intentionally not a database plugin: insights and access-key
 * persistence belong to the server's database provider.
 */
export const standaloneRepository = (
  config: StandaloneRepositoryConfig,
): BundleRepository => {
  const remote = createStandaloneBundleRemote(config);
  const releaseRemote = createStandaloneReleaseRemote(config);

  const repository: BundleRepository = {
    name: "standalone-repository",
    models: {
      bundles: {
        findById: (id) => remote.loadBundleRow(id),
        findMany: async (query) => (await remote.loadBundleWindow(query)).rows,
        count: async (where) =>
          (await remote.loadBundleWindow({ where, limit: 1, offset: 0 })).total,
      },
      bundlePatches: {
        findByBaseBundleIds: (ids) => remote.loadPatchChildren(ids),
        findByBundleIds: (ids) => remote.loadOwnedPatches(ids),
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
