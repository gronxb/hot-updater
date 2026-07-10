import type {
  HotUpdaterContext,
  MaybePromise,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { assertRuntimeStoragePlugin } from "@hot-updater/plugin-core";
import type { DatabasePluginRuntime } from "@hot-updater/plugin-core/internal";

import { createRuntimeDatabaseCore } from "./db/runtimeCore";
import { createSchemaReadinessChecker } from "./db/schemaReadiness";
import {
  type DatabaseAdapter,
  type DatabaseAdapterCapabilities,
  type DatabaseAPI,
  isDatabasePluginRuntime,
  isDatabaseRuntimeOpener,
  type MaybeDatabaseRuntime,
  openDatabaseRuntime,
  type StoragePluginFactory,
} from "./db/types";
import { createHandler, type HandlerRoutes } from "./handler";
import { normalizeBasePath } from "./route";
import { createStorageAccess } from "./storageAccess";

export type RuntimeHotUpdaterAPI<TContext = unknown> = DatabaseAPI<TContext> & {
  readonly basePath: string;
  readonly handler: (
    request: Request,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Response>;
  readonly adapterName: string;
};

export type HotUpdaterAPI<TContext = unknown> = RuntimeHotUpdaterAPI<TContext>;

export interface CreateHotUpdaterOptions<TContext = unknown> {
  readonly database: DatabaseAdapter<TContext>;
  readonly storages?: readonly (
    | StoragePlugin<TContext>
    | StoragePluginFactory<TContext>
  )[];
  /**
   * @deprecated Use `storages` instead. This field will be removed in a future version.
   */
  readonly storagePlugins?: readonly (
    | StoragePlugin<TContext>
    | StoragePluginFactory<TContext>
  )[];
  readonly basePath?: string;
  readonly cwd?: string;
  readonly routes?: HandlerRoutes;
}

type PluginDatabaseCore<TContext> = {
  readonly api: DatabaseAPI<TContext>;
  readonly adapterName: string;
  readonly createMigrator: () => never;
  readonly generateSchema: () => never;
};

const isPromiseLike = <TValue>(value: unknown): value is PromiseLike<TValue> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { readonly then?: unknown }).then === "function";

export const hotUpdaterCoreMetadata = Symbol.for(
  "@hot-updater/server/core-metadata",
);

export type HotUpdaterCoreMetadata<TContext = unknown> = {
  readonly adapterCapabilities: DatabaseAdapterCapabilities;
  readonly core: PluginDatabaseCore<TContext>;
};

export type HotUpdaterCore<TContext = unknown> = {
  readonly api: RuntimeHotUpdaterAPI<TContext>;
  readonly adapterCapabilities: DatabaseAdapterCapabilities;
  readonly core: PluginDatabaseCore<TContext>;
};

export function getHotUpdaterCoreMetadata<TContext = unknown>(
  hotUpdater: RuntimeHotUpdaterAPI<TContext>,
): HotUpdaterCoreMetadata<TContext> | undefined {
  return (
    hotUpdater as RuntimeHotUpdaterAPI<TContext> & {
      readonly [hotUpdaterCoreMetadata]?: HotUpdaterCoreMetadata<TContext>;
    }
  )[hotUpdaterCoreMetadata];
}

export function createHotUpdaterCore<TContext = unknown>(
  options: CreateHotUpdaterOptions<TContext>,
): HotUpdaterCore<TContext> {
  const database = options.database;
  const basePath = normalizeBasePath(options.basePath ?? "/api");
  const storagePlugins = (options.storages ?? options.storagePlugins ?? []).map(
    (plugin) => {
      const storagePlugin = typeof plugin === "function" ? plugin() : plugin;
      assertRuntimeStoragePlugin(storagePlugin);
      return storagePlugin;
    },
  );
  const { readStorageText, resolveFileUrl } =
    createStorageAccess(storagePlugins);

  if (
    !isDatabaseRuntimeOpener(database) &&
    !isPromiseLike<DatabasePluginRuntime>(database) &&
    !isDatabasePluginRuntime(database)
  ) {
    throw new Error(
      "@hot-updater/server only supports database plugin runtimes.",
    );
  }

  const adapterCapabilities = database as DatabaseAdapterCapabilities;
  const openedDatabase: MaybeDatabaseRuntime | undefined =
    isDatabaseRuntimeOpener(database) ? undefined : database;
  const isRuntimePromiseLike =
    openedDatabase !== undefined &&
    isPromiseLike<DatabasePluginRuntime>(openedDatabase);
  const runtimeOpener:
    | ((
        context?: HotUpdaterContext<TContext>,
      ) => MaybePromise<DatabasePluginRuntime>)
    | undefined = isDatabaseRuntimeOpener<TContext>(database)
    ? database
    : isRuntimePromiseLike ||
        (openedDatabase !== undefined &&
          isDatabasePluginRuntime(openedDatabase))
      ? () =>
          isRuntimePromiseLike
            ? Promise.resolve(openedDatabase)
            : openDatabaseRuntime(openedDatabase)
      : undefined;
  if (!runtimeOpener) {
    throw new Error(
      "@hot-updater/server only supports database plugin runtimes.",
    );
  }
  const adapterName =
    adapterCapabilities.adapterName ??
    (!isRuntimePromiseLike &&
    openedDatabase !== undefined &&
    isDatabasePluginRuntime(openedDatabase)
      ? openedDatabase.name
      : "database");
  const assertSchemaReady = createSchemaReadinessChecker(
    adapterName,
    adapterCapabilities.createMigrator,
  );
  const core = (() => {
    return createRuntimeDatabaseCore<TContext>(runtimeOpener, resolveFileUrl, {
      adapterName,
      beforeOperation: assertSchemaReady,
      readStorageText,
    });
  })();

  const internalHandler = createHandler(core.api, {
    basePath,
    routes: options.routes,
  });

  // Some framework adapters strip the mounted base path or pass extra
  // bindings/execution context arguments. Ignore those extras here so the
  // handler can still be mounted directly as a plain Request handler.
  const handler: RuntimeHotUpdaterAPI<TContext>["handler"] = (
    request,
    context,
    ...extraArgs: unknown[]
  ) => {
    if (extraArgs.length > 0) {
      return internalHandler(request);
    }

    return internalHandler(request, context);
  };

  const api = {
    basePath,
    adapterName: adapterCapabilities.adapterName ?? core.adapterName,
    handler,
  };
  Object.defineProperties(api, Object.getOwnPropertyDescriptors(core.api));
  Object.defineProperty(api, hotUpdaterCoreMetadata, {
    enumerable: false,
    value: {
      adapterCapabilities,
      core,
    } satisfies HotUpdaterCoreMetadata<TContext>,
  });

  return {
    api: api as RuntimeHotUpdaterAPI<TContext>,
    adapterCapabilities,
    core,
  };
}

export function createHotUpdater<TContext = unknown>(
  options: CreateHotUpdaterOptions<TContext>,
): RuntimeHotUpdaterAPI<TContext> {
  return createHotUpdaterCore(options).api;
}
