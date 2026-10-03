import type {
  Bundle,
  BundleDeployment,
  DatabaseAdapter,
  EngineDatabase,
} from "@hot-updater/plugin-core";

import { importPublished } from "./published.ts";

const {
  bundleToPatchRows,
  bundleToRow,
  createEngine,
  createMemoryAdapter,
  rowToBundle,
} = await importPublished<typeof import("@hot-updater/plugin-core")>(
  "@hot-updater/plugin-core",
);
const { createHotUpdater } = await importPublished<
  typeof import("@hot-updater/server")
>("@hot-updater/server");

/**
 * Core on an empty database in memory, through a server definition as the
 * CLI writes through one: what the controller's specs give it in place of a
 * provider's.
 */
export const createMemoryCore = () => {
  let reads = 0;
  const memory = createMemoryAdapter();
  const adapter: DatabaseAdapter = {
    ...memory,
    get: (table, keys) => {
      reads += 1;
      return memory.get(table, keys);
    },
    query: (table, request) => {
      reads += 1;
      return memory.query(table, request);
    },
  };
  const database: EngineDatabase = { name: "memory", adapter };
  const { core } = createHotUpdater({ database, clientAccess: "public" });
  return {
    core,
    database,
    /** How many reads reached the database. */
    reads: () => reads,
    /** Deploys one bundle with its release, as `hot-updater deploy` does. */
    deploy: async (deployment: BundleDeployment) =>
      (await core.deploy([deployment]))[0]!,
    /**
     * Stores these bundles, each without a release, as test-utils'
     * `storeBundles` does: deleting a bundle's last release deletes the
     * bundle, so they go in through the engine. A patch's base comes first.
     */
    setBundles: async (bundles: readonly Bundle[]): Promise<void> => {
      const engine = createEngine(database);
      try {
        await engine.core.transaction(async (tx) => {
          for (const bundle of bundles) {
            tx.create("bundles", bundleToRow(bundle));
            for (const platformKey of [bundle.platform, "*"]) {
              tx.aggregate(
                "bundle_totals",
                { platform_key: platformKey },
                { bundles: 1 },
              );
            }
            for (const row of bundleToPatchRows(bundle)) {
              tx.create("bundle_patches", row);
            }
          }
        });
      } finally {
        await engine.dispose();
      }
    },
    bundles: async (): Promise<Bundle[]> =>
      (await core.listBundles({ limit: 100, order: "desc" })).map(
        ({ bundle, patches }) => rowToBundle(bundle, patches),
      ),
    releases: () =>
      core.listReleases({ limit: 100, order: "desc", filter: { kind: "all" } }),
  };
};
