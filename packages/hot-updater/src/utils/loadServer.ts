import {
  type ConfigResponse,
  importServerModule,
  loadConfig,
} from "@hot-updater/cli-tools";
import type {
  ConfiguredDatabase,
  RemoteServer,
  StorageAdapter,
  AnyHotUpdaterPlugin,
} from "@hot-updater/plugin-core";
import {
  type ServerDefinition,
  serverDefinitionOf,
} from "@hot-updater/server/db";

/** The server hot-updater.config.ts points at, as the CLI uses it. */
export type LoadedServer = {
  /** The database commands read and write: the definition's, or the remote server's admin API. */
  readonly database: ConfiguredDatabase;
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
      readonly hotUpdater: unknown;
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
  const definition = serverDefinitionOf(module.hotUpdater);
  if (definition === undefined) {
    throw new ServerConfigError(
      `${path} must export hotUpdater: the server createHotUpdater({ database, storage, plugins }) returns.`,
    );
  }
  return {
    kind: "definition",
    path,
    hotUpdater: module.hotUpdater,
    definition,
    plugins: definition.plugins,
    database: definition.database,
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
