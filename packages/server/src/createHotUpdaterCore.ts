import type {
  DatabasePlugin,
  HotUpdaterContext,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { assertRuntimeStorageOperations } from "@hot-updater/plugin-core";

import { createPluginDatabaseCore } from "./db/pluginCore";
import { createSchemaReadinessChecker } from "./db/schemaReadiness";
import {
  type DatabaseAdapter,
  type DatabaseAdapterCapabilities,
  type DatabaseAPI,
  isDatabasePlugin,
  isDatabasePluginFactory,
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
  readonly storages?: readonly (StoragePlugin | StoragePluginFactory)[];
  /**
   * @deprecated Use `storages` instead. This field will be removed in a future version.
   */
  readonly storagePlugins?: readonly (StoragePlugin | StoragePluginFactory)[];
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
      assertRuntimeStorageOperations(storagePlugin);
      return storagePlugin;
    },
  );
  const { readStorageText, resolveFileUrl } =
    createStorageAccess(storagePlugins);

  if (!isDatabasePluginFactory(database) && !isDatabasePlugin(database)) {
    throw new Error("@hot-updater/server only supports database plugins.");
  }

  const adapterCapabilities = database as DatabaseAdapterCapabilities;
  const plugin: DatabasePlugin<TContext> = isDatabasePluginFactory(database)
    ? database()
    : database;
  const adapterName = adapterCapabilities.adapterName ?? plugin.name;
  const assertSchemaReady = createSchemaReadinessChecker(
    adapterName,
    adapterCapabilities.createMigrator,
  );
  const core = createPluginDatabaseCore<TContext>(
    () => plugin,
    resolveFileUrl,
    isDatabasePluginFactory(database)
      ? {
          createMutationPlugin: () => database(),
          beforeOperation: assertSchemaReady,
          readStorageText,
        }
      : { beforeOperation: assertSchemaReady, readStorageText },
  );

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
