import {
  type AnyHotUpdaterPlugin,
  type ConfiguredDatabase,
  createMemoryAdapter,
  type EngineDatabase,
  type HotUpdaterCoreApi,
  isRemoteDatabase,
  type PluginClientPlugin,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";

/**
 * The server hot-updater.config.ts describes, as the CLI runs it: core and
 * the plugins over the config's database and storage.
 */
export interface AssembledServer {
  /** The config's database: the server's own, or `standaloneRepository(...)`. */
  readonly database: ConfiguredDatabase;
  /**
   * Core's reads and typed writes. Over the server's database they take the
   * server's path: the plugins' schema fence, pruning during writes, the
   * storage's file URLs, and the database's CDN purge. Over
   * `standaloneRepository`, they go through the server's admin API.
   */
  readonly core: HotUpdaterCoreApi;
  /** Where the CLI uploads bundles; undefined when the config names none. */
  readonly storage: StorageAdapter | undefined;
  /** The plugins as configured, as a frozen copy. */
  readonly plugins: readonly AnyHotUpdaterPlugin[];
  /** Each plugin's API by id; undefined over standaloneRepository, whose plugins run on the server. */
  readonly api: Readonly<Record<string, unknown>> | undefined;
  /** The client plugins an app adds for the plugins: what init prints and doctor checks. */
  readonly clientPlugins: readonly PluginClientPlugin[];
  /** The plugin that guards client routes; absent when they are public. */
  readonly clientAuth?: {
    readonly plugin: string;
    /** The request headers its decision reads, lowercase. */
    readonly varyHeaders: readonly string[];
  };
}

/** What `assembleServer` runs: hot-updater.config.ts's `database`, `storage`, and `plugins`. */
export interface AssembleServerOptions {
  readonly database: ConfiguredDatabase;
  readonly storage?: StorageAdapter;
  readonly plugins?: readonly AnyHotUpdaterPlugin[];
}

/** `createHotUpdater`, with public client routes unless a plugin provides clientAuth. */
const createServer = (
  database: EngineDatabase,
  storage: StorageAdapter | undefined,
  plugins: readonly AnyHotUpdaterPlugin[],
) =>
  createHotUpdater({
    database,
    storage,
    plugins,
    ...(plugins.some((plugin) => plugin.provides?.clientAuth)
      ? {}
      : { clientAccess: "public" }),
  } as Parameters<typeof createHotUpdater>[0]);

/**
 * Core and the plugins over hot-updater.config.ts's database, assembled by
 * `createHotUpdater` as the server assembles them, so the CLI's writes take
 * the server's path. Plugins the server would refuse are refused here.
 * Assembling reads and writes nothing, and storage that only uploads is
 * enough: only a server mounts the handlers that serve downloads.
 *
 * Over `standaloneRepository(...)`, core is the server's admin API and the
 * plugins run on the server; here they are only checked, on a database
 * nothing reads, for what the CLI reads from them.
 */
export function assembleServer(
  options: AssembleServerOptions & { readonly database: EngineDatabase },
): AssembledServer & { readonly api: Readonly<Record<string, unknown>> };
export function assembleServer(options: AssembleServerOptions): AssembledServer;
export function assembleServer({
  database,
  storage,
  plugins = [],
}: AssembleServerOptions): AssembledServer {
  if (isRemoteDatabase(database)) {
    const shape = createServer(
      { name: "memory", adapter: createMemoryAdapter() },
      undefined,
      plugins,
    );
    return {
      database,
      core: database.core,
      storage,
      plugins: shape.plugins,
      api: undefined,
      clientPlugins: shape.clientPlugins,
      ...(shape.clientAuth === undefined
        ? {}
        : { clientAuth: shape.clientAuth }),
    };
  }
  const server = createServer(database, storage, plugins);
  return {
    database,
    core: server.core,
    storage,
    plugins: server.plugins,
    api: server.api,
    clientPlugins: server.clientPlugins,
    ...(server.clientAuth === undefined
      ? {}
      : { clientAuth: server.clientAuth }),
  };
}
