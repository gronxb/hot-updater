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

export type HotUpdaterAPI<TContext = unknown> = DatabaseAPI<TContext> & {
  basePath: string;
  handler: (
    request: Request,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Response>;
  adapterName: string;
};

export interface CreateHotUpdaterOptions<TContext = unknown> {
  database: DatabaseAdapter<TContext>;
  storages?: (
    | RuntimeStoragePlugin<TContext>
    | StoragePluginFactory<TContext>
  )[];
  storagePlugins?: (
    | RuntimeStoragePlugin<TContext>
    | StoragePluginFactory<TContext>
  )[];
  basePath?: string;
  cwd?: string;
  routes?: HandlerRoutes;
}

export function createHotUpdater<TContext = unknown>(
  options: CreateHotUpdaterOptions<TContext>,
): HotUpdaterAPI<TContext> {
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
    throw new Error(
      "@hot-updater/server/runtime only supports database plugins.",
    );
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
  const handler: HotUpdaterAPI<TContext>["handler"] = (
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
    adapterName: core.adapterName,
    handler,
  };
  Object.defineProperties(api, Object.getOwnPropertyDescriptors(core.api));
  return api as HotUpdaterAPI<TContext>;
}

export { createHandler };
export { HOT_UPDATER_SERVER_VERSION } from "./version";
