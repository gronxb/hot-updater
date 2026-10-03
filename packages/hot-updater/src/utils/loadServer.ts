import {
  type AssembledServer,
  assembleServer,
  type ConfigResponse,
  loadConfig,
} from "@hot-updater/cli-tools";
import type { StorageAdapter } from "@hot-updater/plugin-core";

/**
 * The server hot-updater.config.ts describes, as the CLI runs it: core and
 * the plugins over the config's database and storage.
 */
export type LoadedServer = AssembledServer & {
  /** Closes what the config opened: its database. */
  dispose(): Promise<void>;
};

export class ServerConfigError extends Error {
  override readonly name = "ServerConfigError";
}

/**
 * The server hot-updater.config.ts describes: core and the plugins over its
 * database and storage, assembled as the server assembles them, so the
 * CLI's writes take the server's path. A database the config names that the
 * plugins cannot run on is closed before the error is thrown.
 */
export const loadServer = async (
  config?: Pick<ConfigResponse, "database" | "storage" | "plugins">,
): Promise<LoadedServer> => {
  const { database, storage, plugins } = config ?? (await loadConfig(null));
  if (database === undefined) {
    throw new ServerConfigError(
      "Set database in hot-updater.config.ts: the database your server runs on, such as d1Database(...), or standaloneRepository({ baseUrl }) to reach a self-hosted server through its admin API.",
    );
  }
  let server: AssembledServer;
  try {
    server = assembleServer({ database, storage, plugins });
  } catch (error) {
    await database.dispose?.();
    throw error;
  }
  return {
    ...server,
    dispose: async () => {
      await database.dispose?.();
    },
  };
};

/** The storage the CLI uploads bundles to: the config's. */
export const requireStorage = (
  server: Pick<LoadedServer, "storage">,
): StorageAdapter => {
  if (server.storage === undefined) {
    throw new ServerConfigError(
      "Set storage in hot-updater.config.ts: where the CLI uploads bundles, such as r2Storage(...).",
    );
  }
  return server.storage;
};
