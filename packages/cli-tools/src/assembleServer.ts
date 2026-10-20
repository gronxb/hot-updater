import {
  type AnyHotUpdaterPlugin,
  type ConfiguredDatabase,
  createMemoryAdapter,
  createStorageAdapter,
  type EngineDatabase,
  type HotUpdaterCoreApi,
  isRemoteDatabase,
  type PluginClientPlugin,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { VaultLockedError } from "@hot-updater/server/plugins";

/**
 * The server hot-updater.config.ts describes, as the CLI runs it: core and
 * the plugins over the config's database.
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
  /**
   * The config's storage, through which core resolves file URLs and the
   * plugins read stored files. Tooling that does neither, such as init
   * provisioning a credential, leaves it out.
   */
  readonly storage?: StorageAdapter;
  readonly plugins?: readonly AnyHotUpdaterPlugin[];
}

/** The storage of an assembly that reads no stored file: it owns no URI. */
const noStorage = createStorageAdapter({ name: "none", protocol: "none" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The plugins' APIs as the CLI uses them: the vault's `reveal` and
 * `rewrap` refuse with `VaultLockedError`, even where the master keys are
 * set or the definition passes `vault({ masterKey })`. Secrets are
 * decrypted, and their data keys unwrapped, only in the Console, which
 * serves them to vault tokens and rewraps them on its Vault page; the CLI
 * still lists them and manages tokens.
 */
export const lockVaultReveal = <T extends Readonly<Record<string, unknown>>>(
  api: T,
): T => {
  const { vault } = api;
  if (!isRecord(vault) || typeof vault.reveal !== "function") return api;
  const reveal = () =>
    Promise.reject(
      new VaultLockedError(
        "The CLI does not reveal vault secrets: the Console decrypts them, and serves them at /_hot-updater/vault/v1/resolve to a vault token.",
      ),
    );
  const rewrap = () =>
    Promise.reject(
      new VaultLockedError(
        "The CLI does not rewrap the vault: only the Console holds its master keys. Rewrap on the Console's Vault page, under Master keys.",
      ),
    );
  return Object.freeze({
    ...api,
    vault: Object.freeze({ ...vault, reveal, rewrap }),
  });
};

/** `createHotUpdater`, with public client routes unless a plugin provides clientAuth. */
const createServer = (
  database: EngineDatabase,
  storage: StorageAdapter,
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
 * nothing reads, for what the CLI reads from them. The vault's `reveal`
 * refuses ({@link lockVaultReveal}).
 */
export function assembleServer(
  options: AssembleServerOptions & { readonly database: EngineDatabase },
): AssembledServer & { readonly api: Readonly<Record<string, unknown>> };
export function assembleServer(options: AssembleServerOptions): AssembledServer;
export function assembleServer({
  database,
  storage = noStorage,
  plugins = [],
}: AssembleServerOptions): AssembledServer {
  if (isRemoteDatabase(database)) {
    const shape = createServer(
      { name: "memory", adapter: createMemoryAdapter() },
      storage,
      plugins,
    );
    return {
      database,
      core: database.core,
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
    plugins: server.plugins,
    api: lockVaultReveal(server.api),
    clientPlugins: server.clientPlugins,
    ...(server.clientAuth === undefined
      ? {}
      : { clientAuth: server.clientAuth }),
  };
}
