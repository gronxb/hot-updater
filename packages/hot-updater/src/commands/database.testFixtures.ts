import type {
  Bundle,
  BundleDeployment,
  Deployment,
  EngineDatabase,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import {
  rowToBundle,
  createMemoryAdapter,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { storeBundles } from "@hot-updater/test-utils";
import { vi } from "vitest";

export type DeploymentSeed = BundleDeployment;

/**
 * A database on the storage engine over a memory adapter, as a provider
 * gives the CLI, with core on it for seeding. `testServer` hands commands
 * `database.core` as the server's core, so a test can spy on its calls.
 * Every read passes `read` first.
 */
export const createDatabaseHarness = () => {
  const read = vi.fn(async (): Promise<void> => {});
  const dispose = vi.fn(async (): Promise<void> => {});
  let memory = createMemoryAdapter();
  const adapter: DatabaseAdapter = {
    id: "memory",
    fits: (ops) => memory.fits(ops),
    get: async (table, keys) => {
      await read();
      return memory.get(table, keys);
    },
    query: async (table, request) => {
      await read();
      return memory.query(table, request);
    },
    write: (ops) => memory.write(ops),
  };
  const { core: engineCore } = createHotUpdater({
    database: { name: "test-database", adapter },
    clientAccess: "public",
  });
  const deploy = vi.fn((deployments: readonly Deployment[]) =>
    engineCore.deploy(deployments),
  );
  const core = { ...engineCore, deploy };
  const database: EngineDatabase & { readonly core: typeof core } = {
    name: "test-database-v2",
    adapter,
    core,
    dispose,
  };

  /** Replaces the database with these bundles, each stored with no release. */
  const setBundles = async (bundles: readonly Bundle[]): Promise<void> => {
    memory = createMemoryAdapter();
    await storeBundles({ name: "test-database", adapter }, bundles);
  };

  return {
    database,
    core,
    deploy,
    read,
    dispose,
    bundles: async (): Promise<Bundle[]> =>
      (await core.listBundles({ limit: 100, order: "desc" })).map(
        ({ bundle, patches }) => rowToBundle(bundle, patches),
      ),
    releases: () =>
      core.listReleases({ limit: 100, order: "desc", filter: { kind: "all" } }),
    reset: (): void => {
      memory = createMemoryAdapter();
      read.mockReset().mockResolvedValue(undefined);
      deploy
        .mockReset()
        .mockImplementation((deployments) => engineCore.deploy(deployments));
      dispose.mockClear();
    },
    setBundles,
    /** Replaces the database with these deployments, one deploy each, and returns their releases. */
    seedDeployments: async (
      deployments: readonly DeploymentSeed[],
    ): Promise<ReleaseRow[]> => {
      memory = createMemoryAdapter();
      const releases: ReleaseRow[] = [];
      for (const deployment of deployments) {
        const [result] = await engineCore.deploy([deployment]);
        releases.push(result!.release!);
      }
      return releases;
    },
  };
};
