import {
  assertStorageOperations,
  type StoragePlugin,
} from "@hot-updater/plugin-core";
import type { DatabaseAdapter } from "@hot-updater/plugin-core/internal";

import {
  assemblePlugins,
  HotUpdaterConfigError,
} from "./assembly/assemblePlugins";
import type { CoreApi } from "./core/api";
import { toolingTargetOf } from "./database/builtInDatabase";
import type { ToolingDatabase, ToolingTarget } from "./db/types";
import {
  type ClientRoutePolicy,
  createHotUpdaterHandlers,
  type HotUpdaterHandlers,
} from "./handler";
import type { AnyHotUpdaterPlugin, PluginApis } from "./plugins/definePlugin";
import { createStorageAccess } from "./storageAccess";

export type RuntimeHotUpdaterAPI<
  TPlugins extends readonly AnyHotUpdaterPlugin[] =
    readonly AnyHotUpdaterPlugin[],
> = {
  readonly handlers: HotUpdaterHandlers;
  /** Core's reads and typed writes: bundles, Releases, Catalogs, and channels. */
  readonly core: CoreApi;
  /** Each plugin's API by plugin id. */
  readonly api: PluginApis<TPlugins>;
  /** The database's name, which `hot-updater db` commands read. */
  readonly adapterName: string;
};

export type HotUpdaterAPI = RuntimeHotUpdaterAPI;

const REMOVED_CLIENT_ACCESS =
  'clientAccess objects were removed in 1.0: set clientAccess: "public", or add apiKeys() from @hot-updater/server/plugins/api-keys to plugins';

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
  /** Storage implementations used to read provider-specific storage URIs. */
  readonly storage?: readonly StoragePlugin[];
  /** Built-in and third-party plugins; at most one provides clientAuth. Defaults to none. */
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

/** `"public"`, or nothing; a `clientAccess` object names what replaced it. */
const isPublic = (value: unknown): boolean => {
  if (value === undefined) return false;
  if (value === "public") return true;
  if (isRecord(value)) {
    const type = value.type;
    throw new HotUpdaterConfigError(
      type === "api-key"
        ? `clientAccess: { type: "api-key" } was removed in 1.0. Remove it and add apiKeys(${value.headerName === undefined ? "" : `{ headerName: ${JSON.stringify(value.headerName)} }`}) from @hot-updater/server/plugins/api-keys to plugins, which protects client routes the same way.`
        : `clientAccess objects were removed in 1.0. Use clientAccess: "public", or add apiKeys() from @hot-updater/server/plugins/api-keys to plugins.`,
    );
  }
  throw new HotUpdaterConfigError(
    'clientAccess must be "public"; to protect client routes, add apiKeys() from @hot-updater/server/plugins/api-keys to plugins.',
  );
};

export const hotUpdaterCoreMetadata = Symbol.for(
  "@hot-updater/server/core-metadata",
);

export type HotUpdaterCoreMetadata = {
  /** The configured database, with the tooling `hot-updater db` runs. */
  readonly database: ToolingDatabase;
  /** The tables and settings rows that tooling creates for this server's plugins. */
  readonly target: ToolingTarget;
};

export function getHotUpdaterCoreMetadata(
  hotUpdater: RuntimeHotUpdaterAPI,
): HotUpdaterCoreMetadata | undefined {
  return (
    hotUpdater as RuntimeHotUpdaterAPI & {
      readonly [hotUpdaterCoreMetadata]?: HotUpdaterCoreMetadata;
    }
  )[hotUpdaterCoreMetadata];
}

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
  const storagePlugins = (options.storage ?? []).map((storage) => {
    assertStorageOperations(storage, ["get", "getDownloadUrl"]);
    return storage;
  });
  const { downloadStorageObject, readStorageText, resolveFileUrl } =
    createStorageAccess(storagePlugins);
  const publicClients = isPublic(
    (options as { readonly clientAccess?: unknown }).clientAccess,
  );
  const plugins = assemblePlugins(options.plugins ?? [], database.adapter, {
    storage: { readStorageText, resolveFileUrl },
  });
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
  const clientPolicy: ClientRoutePolicy | undefined =
    clientAuth === undefined
      ? undefined
      : {
          varyHeaders: clientAuth.varyHeaders.map((header) =>
            header.toLowerCase(),
          ),
          authenticate: (request) => clientAuth.authenticate(request.headers),
        };
  const handlers = createHotUpdaterHandlers({
    api: { core: plugins.core },
    ...(clientPolicy === undefined ? {} : { clientPolicy }),
    downloadStorageObject,
    endpoints: plugins.endpoints,
  });

  const api = {
    adapterName: database.name,
    handlers,
    core: plugins.core,
    api: plugins.api as PluginApis<TPlugins>,
  };
  Object.defineProperty(api, hotUpdaterCoreMetadata, {
    enumerable: false,
    value: {
      database,
      target: toolingTargetOf(options.plugins ?? []),
    } satisfies HotUpdaterCoreMetadata,
  });
  return api;
}
