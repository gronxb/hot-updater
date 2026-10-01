import {
  assertStorageOperations,
  type PluginClientPlugin,
  type StorageAdapter,
} from "@hot-updater/plugin-core";
import type {
  ToolingDatabase,
  DatabaseAdapter,
} from "@hot-updater/plugin-core";

import {
  assemblePlugins,
  HotUpdaterConfigError,
} from "./assembly/assemblePlugins";
import { clientPluginsOf } from "./assembly/clientPlugins";
import type { CoreApi } from "./core/api";
import {
  type ClientRoutePolicy,
  createHotUpdaterHandlers,
  type HotUpdaterHandlers,
} from "./handler";
import type { AnyHotUpdaterPlugin, PluginApis } from "./plugins/definePlugin";
import { createStorageAccess } from "./storageAccess";

/** A plugin's endpoint on `handlers.client`. */
export interface ClientEndpoint {
  /** The id of the plugin that adds it. */
  readonly plugin: string;
  readonly method: string;
  /** Relative to the handler's mount; `:name` segments are parameters. */
  readonly path: string;
}

/** The plugin that decides who may call client routes. */
export interface ClientAuthProvider {
  /** Its id. */
  readonly plugin: string;
  /**
   * The request headers its decision reads, lowercase: what a cache in
   * front of the server, such as a CDN, keys client routes on.
   */
  readonly varyHeaders: readonly string[];
}

export type RuntimeHotUpdaterAPI<
  TPlugins extends readonly AnyHotUpdaterPlugin[] =
    readonly AnyHotUpdaterPlugin[],
> = {
  /**
   * The routes a host mounts. On first access every storage adapter must
   * serve downloads (`get` and `getDownloadUrl`), so a server fails where it
   * mounts them, while tooling that only reads the definition, such as the
   * CLI, can list storage that only uploads.
   */
  readonly handlers: HotUpdaterHandlers;
  /**
   * Core's reads and typed writes: bundles, Releases, Catalogs, and
   * channels. The CLI and the console write through it, so their writes
   * take the server's path: the plugins' schema fence, pruning during
   * writes, the storage's file URLs, and the database's CDN purge.
   */
  readonly core: CoreApi;
  /** Each plugin's API by plugin id, which the CLI's and the console's plugin features call. */
  readonly api: PluginApis<TPlugins>;
  /** The database's name, which `hot-updater db` commands read. */
  readonly adapterName: string;
  /**
   * Applies aggregate changes the database batches that are still pending:
   * this process's buffer, and the log rows no compaction has merged yet.
   * A long-lived server with `aggregateBatching: { mode: "memory" }` calls
   * it before it exits.
   */
  readonly flush: () => Promise<void>;
  /**
   * The database as configured. `hot-updater db` runs its tooling
   * (`createMigrator`, `generateSchema`), and tooling done with the server
   * closes it (`dispose`).
   */
  readonly database: ToolingDatabase;
  /** The storage as configured, in order, as a frozen copy. */
  readonly storage: readonly StorageAdapter[];
  /** The plugins as configured, as a frozen copy, whose tables tooling creates. */
  readonly plugins: TPlugins;
  /**
   * The client plugins an app adds to `HotUpdater.init`'s `plugins` for
   * these plugins, each once, in plugin order: what init prints.
   */
  readonly clientPlugins: readonly PluginClientPlugin[];
  /**
   * The plugins' endpoints on `handlers.client`, which a host that routes
   * by path, such as a CDN in front of the server, sends to it.
   */
  readonly clientEndpoints: readonly ClientEndpoint[];
  /** The plugin that guards client routes; absent when they are public. */
  readonly clientAuth?: ClientAuthProvider;
};

export type HotUpdaterAPI = RuntimeHotUpdaterAPI;

const REMOVED_CLIENT_ACCESS =
  'clientAccess objects were removed in 1.0: set clientAccess: "public", or add a plugin that provides clientAuth';

/**
 * A `clientAccess` object from before 1.0. Its `type` names the fix, so
 * TypeScript reports it where the object is written.
 */
export interface RemovedClientAccess {
  readonly type: typeof REMOVED_CLIENT_ACCESS;
  readonly headerName?: string;
}

export type ClientAccessPolicy =
  /** Leaves client routes public; required when no plugin provides clientAuth. */
  "public" | RemovedClientAccess;

type ProvidesClientAuth<TPlugin> = TPlugin extends {
  readonly provides?: infer TProvides;
}
  ? TProvides extends { readonly clientAuth: true }
    ? true
    : false
  : false;

type ClientAuthIds<
  TPlugins extends readonly unknown[],
  TFound extends string[] = [],
> = TPlugins extends readonly [infer THead, ...infer TTail]
  ? ClientAuthIds<
      TTail,
      ProvidesClientAuth<THead> extends true
        ? [
            ...TFound,
            THead extends { readonly id: infer TId extends string }
              ? TId
              : string,
          ]
        : TFound
    >
  : TFound;

type JoinIds<TIds extends string[]> = TIds extends [
  infer TFirst extends string,
  ...infer TRest extends string[],
]
  ? TRest extends []
    ? `"${TFirst}"`
    : `"${TFirst}", ${JoinIds<TRest>}`
  : "";

/**
 * Client routes have one policy source: exactly one plugin that provides
 * clientAuth, or an explicit `clientAccess`. Tuples are counted here; an
 * untyped list that may hold a clientAuth plugin is left to startup.
 */
export type ClientAccessRule<TPlugins extends readonly AnyHotUpdaterPlugin[]> =
  number extends TPlugins["length"]
    ? true extends ProvidesClientAuth<TPlugins[number]>
      ? {
          readonly clientAccess?: "Remove clientAccess: a plugin in this list may provide clientAuth";
        }
      : { readonly clientAccess: ClientAccessPolicy }
    : ClientAuthIds<TPlugins> extends []
      ? { readonly clientAccess: ClientAccessPolicy }
      : ClientAuthIds<TPlugins> extends [infer TId extends string]
        ? {
            readonly clientAccess?: `Remove clientAccess: plugin "${TId}" provides clientAuth`;
          }
        : {
            readonly clientAuth: `Keep one clientAuth plugin: ${JoinIds<ClientAuthIds<TPlugins>>} all provide it`;
          };

export type CreateHotUpdaterOptions<
  TPlugins extends readonly AnyHotUpdaterPlugin[] = readonly [],
> = {
  /** A provider's database on the storage engine, such as `kyselyAdapter(...)` or `postgres(...)`. */
  readonly database: ToolingDatabase;
  /**
   * Where bundles are stored: the server reads and signs the URIs of each
   * adapter's protocol.
   */
  readonly storage?: readonly StorageAdapter[];
  /** The plugins the server runs; at most one provides clientAuth. Defaults to none. */
  readonly plugins?: TPlugins;
} & ClientAccessRule<TPlugins>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isAdapter = (value: unknown): value is DatabaseAdapter =>
  isRecord(value) &&
  ["fits", "get", "query", "write"].every(
    (method) => typeof value[method] === "function",
  );

/** The configured database, when it runs on the storage engine. */
const databaseOf = (value: unknown): ToolingDatabase => {
  if (isRecord(value) && typeof value.name === "string") {
    if (isAdapter(value.adapter)) return value as unknown as ToolingDatabase;
    if ("core" in value && "fetchAdmin" in value) {
      throw new HotUpdaterConfigError(
        "standaloneRepository reaches a server's admin API from the CLI and console. createHotUpdater needs the server's own database, such as kyselyAdapter(...).",
      );
    }
  }
  throw new HotUpdaterConfigError(
    "database must be a Hot Updater 1.0 database, such as kyselyAdapter(...) or postgres(...). Upgrade the provider package that created it.",
  );
};

/** `"public"`, or nothing; a `clientAccess` object says what replaced it. */
const isPublic = (value: unknown): boolean => {
  if (value === undefined) return false;
  if (value === "public") return true;
  throw new HotUpdaterConfigError(
    isRecord(value)
      ? 'clientAccess objects were removed in 1.0. Set clientAccess: "public", or add a plugin that provides clientAuth to plugins.'
      : 'clientAccess must be "public"; to protect client routes, add a plugin that provides clientAuth to plugins.',
  );
};

export function createHotUpdater<
  const TPlugins extends readonly AnyHotUpdaterPlugin[] = readonly [],
>(
  options: CreateHotUpdaterOptions<TPlugins>,
): RuntimeHotUpdaterAPI<NoInfer<TPlugins>> {
  for (const key of ["authorityId", "catalogId"]) {
    if (Object.hasOwn(options, key)) {
      throw new TypeError(
        `Remove ${key} from createHotUpdater options. Catalog identity is managed internally.`,
      );
    }
  }
  const database = databaseOf(options.database);
  // Copies, so changing the arrays passed in can't make the definition list
  // other storage or plugins than the ones it runs.
  const storage = Object.freeze([...(options.storage ?? [])]);
  const { downloadStorageObject, readStorageText, resolveFileUrl } =
    createStorageAccess(storage);
  const publicClients = isPublic(
    (options as { readonly clientAccess?: unknown }).clientAccess,
  );
  const configured = Object.freeze([
    ...(options.plugins ?? []),
  ]) as unknown as TPlugins;
  const plugins = assemblePlugins(configured, database, {
    storage: { readStorageText, resolveFileUrl },
  });
  const clientPlugins = Object.freeze(clientPluginsOf(configured));
  const clientAuth = plugins.clientAuth;
  if (clientAuth !== undefined && publicClients) {
    throw new HotUpdaterConfigError(
      `Plugin "${clientAuth.plugin}" provides clientAuth, so remove clientAccess.`,
    );
  }
  if (clientAuth === undefined && !publicClients) {
    throw new HotUpdaterConfigError(
      'Set clientAccess to "public", or add a plugin that provides clientAuth.',
    );
  }
  const varyHeaders = Object.freeze(
    (clientAuth?.varyHeaders ?? []).map((header) => header.toLowerCase()),
  );
  const clientPolicy: ClientRoutePolicy | undefined =
    clientAuth === undefined
      ? undefined
      : {
          varyHeaders,
          authenticate: (request) => clientAuth.authenticate(request.headers),
        };
  const handlers = createHotUpdaterHandlers({
    api: { core: plugins.core },
    ...(clientPolicy === undefined ? {} : { clientPolicy }),
    downloadStorageObject,
    endpoints: plugins.endpoints,
    plugins: Object.keys(plugins.api),
  });
  let serving = false;

  return {
    adapterName: database.name,
    get handlers(): HotUpdaterHandlers {
      if (!serving) {
        for (const adapter of storage) {
          assertStorageOperations(adapter, ["get", "getDownloadUrl"]);
        }
        serving = true;
      }
      return handlers;
    },
    core: plugins.core,
    api: plugins.api as PluginApis<TPlugins>,
    flush: plugins.flush,
    database,
    storage,
    plugins: configured,
    clientPlugins,
    clientEndpoints: Object.freeze(
      plugins.endpoints
        .filter((endpoint) => endpoint.access === "client")
        .map(({ plugin, method, path }) =>
          Object.freeze({ plugin, method, path }),
        ),
    ),
    ...(clientAuth === undefined
      ? {}
      : {
          clientAuth: Object.freeze({ plugin: clientAuth.plugin, varyHeaders }),
        }),
  };
}
