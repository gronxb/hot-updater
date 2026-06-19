import type {
  DatabasePlugin,
  HotUpdaterContext,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";
import { assertRuntimeStoragePlugin } from "@hot-updater/plugin-core";

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

export interface CreateHotUpdaterOptions<TContext = unknown> {
  readonly database: DatabaseAdapter<TContext>;
  readonly storages?: readonly (
    | RuntimeStoragePlugin<TContext>
    | StoragePluginFactory<TContext>
  )[];
  /**
   * @deprecated Use `storages` instead. This field will be removed in a future version.
   */
  readonly storagePlugins?: readonly (
    | RuntimeStoragePlugin<TContext>
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

export type HotUpdaterCore<TContext = unknown> = {
  readonly api: RuntimeHotUpdaterAPI<TContext>;
  readonly capabilities: DatabaseAdapterCapabilities;
  readonly core: PluginDatabaseCore<TContext>;
};

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

  if (!isDatabasePluginFactory(database) && !isDatabasePlugin(database)) {
    throw new Error("@hot-updater/server only supports database plugins.");
  }

  const capabilities = database as DatabaseAdapterCapabilities;
  const plugin: DatabasePlugin<TContext> = isDatabasePluginFactory(database)
    ? database()
    : database;
  const adapterName = capabilities.adapterName ?? plugin.name;
  const assertSchemaReady = createSchemaReadinessChecker(
    adapterName,
    capabilities.createMigrator,
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
    adapterName: capabilities.adapterName ?? core.adapterName,
    handler,
  };
  Object.defineProperties(api, Object.getOwnPropertyDescriptors(core.api));

  return {
    api: api as RuntimeHotUpdaterAPI<TContext>,
    capabilities,
    core,
  };
}
