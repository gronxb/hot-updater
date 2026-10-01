import {
  type ConfigResponse,
  importServerModule,
  loadConfig,
  type ServerDefinition,
  serverDefinitionOf,
} from "@hot-updater/cli-tools";
import type {
  ConfiguredDatabase,
  HotUpdaterCoreApi,
  RemoteServer,
  StorageAdapter,
  AnyHotUpdaterPlugin,
} from "@hot-updater/plugin-core";

/** The server hot-updater.config.ts points at, as the CLI uses it. */
export type LoadedServer = {
  /** The database commands read and write: the definition's, or the remote server's admin API. */
  readonly database: ConfiguredDatabase;
  /**
   * Core's API, which commands read and write through: the definition's, on
   * the server's own path, or the remote server's admin API.
   */
  readonly core: HotUpdaterCoreApi;
  /** Where bundles are stored, in order; the CLI uploads to the first. */
  readonly storage: readonly StorageAdapter[];
  /** Closes what the CLI opened: the module's `closeDatabase`, or the database. */
  dispose(): Promise<void>;
} & (
  | {
      readonly kind: "definition";
      /** The server definition's absolute path. */
      readonly path: string;
      /** What `createHotUpdater` returned. */
      readonly definition: ServerDefinition;
      readonly plugins: readonly AnyHotUpdaterPlugin[];
    }
  | {
      readonly kind: "remote";
      /** A self-hosted server, reached through its admin API. */
      readonly server: RemoteServer;
    }
);

export class ServerConfigError extends Error {
  override readonly name = "ServerConfigError";
}

/**
 * Loads the server definition module at `path`: its `hotUpdater` export,
 * which `createHotUpdater` returned.
 */
export const loadServerDefinition = async (
  path: string,
): Promise<Extract<LoadedServer, { kind: "definition" }>> => {
  const module = await importServerModule(path);
  let definition: ServerDefinition;
  try {
    definition = serverDefinitionOf(module.hotUpdater, path);
  } catch (error) {
    throw new ServerConfigError((error as Error).message, { cause: error });
  }
  return {
    kind: "definition",
    path,
    definition,
    plugins: definition.plugins,
    database: definition.database,
    core: definition.core,
    storage: definition.storage,
    dispose: async () => {
      if (!(await module.closeDatabase())) {
        await definition.database.dispose?.();
      }
    },
  };
};

/**
 * The server hot-updater.config.ts's `server` points at: the server
 * definition it names, or the self-hosted server `standaloneRepository`
 * reaches.
 */
export const loadServer = async (
  config?: Pick<ConfigResponse, "server">,
): Promise<LoadedServer> => {
  const { server } = config ?? (await loadConfig(null));
  if (server === undefined) {
    throw new ServerConfigError(
      'Set server in hot-updater.config.ts: the path to the module that exports your server definition, such as "./src/hotUpdater.ts", or standaloneRepository(...).',
    );
  }
  if (typeof server === "string") return loadServerDefinition(server);
  return {
    kind: "remote",
    server,
    database: server,
    core: server.core,
    storage: server.storage,
    dispose: async () => {
      await server.dispose?.();
    },
  };
};

/** The storage the CLI uploads bundles to: the server's first. */
export const uploadStorageOf = (server: LoadedServer): StorageAdapter => {
  const [storage] = server.storage;
  if (storage === undefined) {
    throw new ServerConfigError(
      server.kind === "remote"
        ? "standaloneRepository has no storage: add the storage the CLI uploads bundles to."
        : `${server.path} lists no storage: add the storage the CLI uploads bundles to, first in createHotUpdater's storage.`,
    );
  }
  return storage;
};
