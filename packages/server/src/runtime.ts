import type {
  HotUpdaterContext,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";
import { assertRuntimeStoragePlugin } from "@hot-updater/plugin-core";

import { createPluginDatabaseCore } from "./db/pluginCore";
import {
  type DatabaseAdapter,
  type DatabaseAPI,
  isDatabasePlugin,
  isDatabasePluginFactory,
  type StoragePluginFactory,
} from "./db/types";
import {
  createHandler,
  type HandlerOptions,
  type HandlerRoutes,
} from "./handler";
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
  authorizeBundleRequest?: HandlerOptions["authorizeBundleRequest"];
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

  const plugin = isDatabasePluginFactory(database) ? database() : database;
  const core = createPluginDatabaseCore<TContext>(
    () => plugin,
    resolveFileUrl,
    isDatabasePluginFactory(database)
      ? {
          createMutationPlugin: () => database(),
          readStorageText,
        }
      : { readStorageText },
  );

  const api = {
    ...core.api,
    handler: createHandler(core.api, {
      basePath,
      routes: options.routes,
      authorizeBundleRequest: options.authorizeBundleRequest,
    }),
    adapterName: core.adapterName,
  };

  // Some framework adapters strip the mounted base path or pass extra
  // bindings/execution context arguments. Ignore those extras here so the
  // handler can still be mounted directly as a plain Request handler.
  const handler: HotUpdaterAPI<TContext>["handler"] = (
    request,
    context,
    ...extraArgs: unknown[]
  ) => {
    if (extraArgs.length > 0) {
      return api.handler(request);
    }

    return api.handler(request, context);
  };

  return {
    ...api,
    basePath,
    handler,
  };
}

export { createHandler };
export { HOT_UPDATER_SERVER_VERSION } from "./version";
