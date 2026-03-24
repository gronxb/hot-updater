import type {
  HotUpdaterContext,
  StoragePlugin,
} from "@hot-updater/plugin-core";
import { createHandler, type HandlerRoutes } from "../handler";
import { normalizeBasePath } from "../route";
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

export type HotUpdaterAPI<TEnv = unknown> = DatabaseAPI<TEnv> & {
  basePath: string;
  handler: (
    request: Request,
    context?: HotUpdaterContext<TEnv>,
  ) => Promise<Response>;
  adapterName: string;
  createMigrator: () => Migrator;
  generateSchema: HotUpdaterClient["generateSchema"];
};

export interface CreateHotUpdaterOptions<TEnv = unknown> {
  database: DatabaseAdapter<TEnv>;
  /**
   * Storage plugins for handling file uploads and downloads.
   */
  storages?: (StoragePlugin<TEnv> | StoragePluginFactory<TEnv>)[];
  /**
   * @deprecated Use `storages` instead. This field will be removed in a future version.
   */
  storagePlugins?: (StoragePlugin<TEnv> | StoragePluginFactory<TEnv>)[];
  basePath?: string;
  cwd?: string;
  routes?: HandlerRoutes;
}

export function createHotUpdater<TEnv = unknown>(
  options: CreateHotUpdaterOptions<TEnv>,
): HotUpdaterAPI<TEnv> {
  const basePath = normalizeBasePath(options.basePath ?? "/api");

  // Initialize storage plugins - call factories if they are functions
  const storagePlugins = (
    options.storages ??
    options.storagePlugins ??
    []
  ).map((plugin) => (typeof plugin === "function" ? plugin() : plugin));

  const resolveStoragePluginUrl = async (
    storageUri: string | null,
    context?: HotUpdaterContext<TEnv>,
  ): Promise<string | null> => {
    if (!storageUri) {
      return null;
    }
    const url = new URL(storageUri);
    const protocol = url.protocol.replace(":", "");
    if (protocol === "http" || protocol === "https") {
      return storageUri;
    }
    const plugin = storagePlugins.find((p) => p.supportedProtocol === protocol);

    if (!plugin) {
      throw new Error(`No storage plugin for protocol: ${protocol}`);
    }
    const { fileUrl } = await plugin.getDownloadUrl(storageUri, context);
    if (!fileUrl) {
      throw new Error("Storage plugin returned empty fileUrl");
    }
    return fileUrl;
  };

  const resolveFileUrl = async (
    storageUri: string | null,
    context?: HotUpdaterContext<TEnv>,
  ) => {
    return resolveStoragePluginUrl(storageUri, context);
  };

  const database = options.database;

  const core =
    isDatabasePluginFactory(database) || isDatabasePlugin(database)
      ? createPluginDatabaseCore<TEnv>(
          isDatabasePluginFactory(database) ? database() : database,
          resolveFileUrl,
        )
      : createOrmDatabaseCore<TEnv>({
          database,
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
