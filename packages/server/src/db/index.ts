import type {
  DatabasePlugin,
  HotUpdaterContext,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";
import { assertRuntimeStoragePlugin } from "@hot-updater/plugin-core";

export * from "./createBundleDiff";
import { createHandler, type HandlerRoutes } from "../handler";
import { normalizeBasePath } from "../route";
import { createStorageAccess } from "../storageAccess";
import {
  createOrmDatabaseCore,
  type HotUpdaterClient,
  type Migrator,
} from "./ormCore";
import { createPluginDatabaseCore } from "./pluginCore";
import {
  type DatabaseAdapter,
  type DatabaseAPI,
  isDatabasePlugin,
  isDatabasePluginFactory,
  type StoragePluginFactory,
} from "./types";

export type { HotUpdaterClient, Migrator } from "./ormCore";
export { HotUpdaterDB } from "./ormCore";
export { HOT_UPDATER_SERVER_VERSION } from "../version";

export type HotUpdaterAPI<TContext = unknown> = DatabaseAPI<TContext> & {
  basePath: string;
  handler: (
    request: Request,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Response>;
  adapterName: string;
  createMigrator: () => Migrator;
  generateSchema: HotUpdaterClient["generateSchema"];
};

export interface CreateHotUpdaterOptions<TContext = unknown> {
  database: DatabaseAdapter<TContext>;
  /**
   * Storage plugins for handling file uploads and downloads.
   */
  storages?: (
    | RuntimeStoragePlugin<TContext>
    | StoragePluginFactory<TContext>
  )[];
  /**
   * @deprecated Use `storages` instead. This field will be removed in a future version.
   */
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
  const basePath = normalizeBasePath(options.basePath ?? "/api");

  // Initialize storage plugins - call factories if they are functions
  const storagePlugins = (options.storages ?? options.storagePlugins ?? []).map(
    (plugin) => {
      const storagePlugin = typeof plugin === "function" ? plugin() : plugin;
      assertRuntimeStoragePlugin(storagePlugin);
      return storagePlugin;
    },
  );
  const { readStorageText, resolveFileUrl } =
    createStorageAccess(storagePlugins);

  const database = options.database;

  const core =
    isDatabasePluginFactory(database) || isDatabasePlugin(database)
      ? (() => {
          const plugin: DatabasePlugin<TContext> = isDatabasePluginFactory(
            database,
          )
            ? database()
            : database;

          return createPluginDatabaseCore<TContext>(
            () => plugin,
            resolveFileUrl,
            isDatabasePluginFactory(database)
              ? {
                  createMutationPlugin: () => database(),
                  readStorageText,
                }
              : { readStorageText },
          );
        })()
      : createOrmDatabaseCore<TContext>({
          database,
          readStorageText,
          resolveFileUrl,
        });

  const api = {
    ...core.api,
    handler: createHandler(core.api, {
      basePath,
      routes: options.routes,
    }),
    adapterName: core.adapterName,
    createMigrator: core.createMigrator,
    generateSchema: core.generateSchema,
  };

  return {
    ...api,
    basePath,
    handler: api.handler,
  };
}
