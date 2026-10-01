import {
  type AnyHotUpdaterPlugin,
  type ConfiguredDatabase,
  createMemoryAdapter,
  type EngineDatabase,
  type HotUpdaterCoreApi,
  isRemoteDatabase,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";

import type {
  ConsoleAuthAdapter,
  HotUpdaterConsoleConfigSource,
} from "../../index";

/** What the console runs on, assembled from its config as the server is. */
export interface ResolvedConsoleConfig {
  readonly gitUrl?: string;
  /** The server's database, or its admin API. */
  readonly database: ConfiguredDatabase;
  /**
   * Core's API, assembled over the database as the server assembles it, so
   * the console's writes take the server's path, or a self-hosted server's
   * admin API.
   */
  readonly core: HotUpdaterCoreApi;
  /** The server's storage; each bundle file is read with its protocol's. */
  readonly storage: readonly StorageAdapter[];
  /** The plugins the server runs, as the config lists them. */
  readonly plugins: readonly AnyHotUpdaterPlugin[];
  /**
   * The plugins' APIs by id, which serve their features; absent over a
   * self-hosted server's admin API, whose plugins run on the server.
   */
  readonly api?: Readonly<Record<string, unknown>>;
}

/**
 * Core and the plugins over `database`, assembled by `createHotUpdater` as
 * the server assembles them, with public client routes unless a plugin
 * provides clientAuth: the console mounts no handlers. cli-tools'
 * `assembleServer` does the same for the CLI; the console keeps its own
 * copy, since a hosted console never loads cli-tools.
 */
const assemble = (
  database: EngineDatabase,
  storage: StorageAdapter,
  plugins: readonly AnyHotUpdaterPlugin[],
) =>
  createHotUpdater({
    database,
    storage: [storage],
    plugins,
    ...(plugins.some((plugin) => plugin.provides?.clientAuth)
      ? {}
      : { clientAccess: "public" }),
  } as Parameters<typeof createHotUpdater>[0]);

export const getConsoleAuthAdapter = async (): Promise<ConsoleAuthAdapter> => {
  const module = await import("virtual:hot-updater-console/auth");
  return module.default;
};

export const resolveConsoleConfig = async (
  request: Request,
): Promise<ResolvedConsoleConfig> => {
  const { default: source } =
    (await import("virtual:hot-updater-console/config")) as {
      readonly default: HotUpdaterConsoleConfigSource;
    };

  const config = typeof source === "function" ? await source(request) : source;
  const { database, storage, plugins = [] } = config;
  const gitUrl =
    config.console?.gitUrl === undefined
      ? {}
      : { gitUrl: config.console.gitUrl };
  // A self-hosted server runs the plugins itself: core is its admin API.
  // The plugins are still checked as the server checks them, on a database
  // nothing reads, so one the server would refuse is refused here too.
  if (isRemoteDatabase(database)) {
    const checked = assemble(
      { name: "memory", adapter: createMemoryAdapter() },
      storage,
      plugins,
    );
    return {
      ...gitUrl,
      database,
      core: database.core,
      storage: [storage],
      plugins: checked.plugins,
    };
  }
  const server = assemble(database, storage, plugins);
  return {
    ...gitUrl,
    database,
    core: server.core,
    storage: server.storage,
    plugins: server.plugins,
    api: server.api,
  };
};
