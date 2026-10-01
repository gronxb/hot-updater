import type {
  Bundle,
  BundleDeployment,
  DatabaseAdapter,
  EngineDatabase,
} from "@hot-updater/plugin-core";

import { importPublished } from "./published.ts";

const { createMemoryAdapter, rowToBundle } = await importPublished<
  typeof import("@hot-updater/plugin-core")
>("@hot-updater/plugin-core");
const { createHotUpdater } = await importPublished<
  typeof import("@hot-updater/server")
>("@hot-updater/server");

/** A disabled release in a channel of its own, so a stored bundle needs one. */
const SEED_RELEASE = {
  channel: "seed",
  enabled: false,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion: "*",
} as const;

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
    /** Stores these bundles, each without a release. */
    setBundles: async (bundles: readonly Bundle[]): Promise<void> => {
      for (const bundle of bundles) {
        const [result] = await core.deploy([
          { bundle, release: SEED_RELEASE },
        ]);
        await core.deleteRelease({ releaseId: result!.release!.id });
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
