import type { StoragePlugin } from "@hot-updater/plugin-core";
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

type OrmCore = ReturnType<typeof createOrmDatabaseCore>;
type PluginCore = ReturnType<typeof createPluginDatabaseCore>;
type HotUpdaterCoreInternal = OrmCore | PluginCore;

export type HotUpdaterAPI = DatabaseAPI & {
  basePath: string;
  handler: (request: Request) => Promise<Response>;
  adapterName: string;
  createMigrator: () => Migrator;
  generateSchema: HotUpdaterClient["generateSchema"];
};

export interface CreateHotUpdaterOptions {
  database: DatabaseAdapter;
  /**
   * Storage plugins for handling file uploads and downloads.
   */
  storages?: (StoragePlugin | StoragePluginFactory)[];
  /**
   * @deprecated Use `storages` instead. This field will be removed in a future version.
   */
  storagePlugins?: (StoragePlugin | StoragePluginFactory)[];
  basePath?: string;
  cwd?: string;
  routes?: HandlerRoutes;
}

export function createHotUpdater(
  options: CreateHotUpdaterOptions,
): HotUpdaterAPI {
  const basePath = normalizeBasePath(options.basePath ?? "/api");

  // Initialize storage plugins - call factories if they are functions
  const storagePlugins = (
    options?.storages ??
    options?.storagePlugins ??
    []
  ).map((plugin) => (typeof plugin === "function" ? plugin() : plugin));

  const resolveStoragePluginUrl = async (
    storageUri: string | null,
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
    const { fileUrl } = await plugin.getDownloadUrl(storageUri);
    if (!fileUrl) {
      throw new Error("Storage plugin returned empty fileUrl");
    }
    return fileUrl;
  };

  const resolveFileUrl = async (storageUri: string | null) => {
    return resolveStoragePluginUrl(storageUri);
  };

  let core: HotUpdaterCoreInternal;

  const database = options.database;

  if (isDatabasePluginFactory(database) || isDatabasePlugin(database)) {
    const plugin = isDatabasePluginFactory(database) ? database() : database;
    core = createPluginDatabaseCore(plugin, resolveFileUrl);
  } else {
    core = createOrmDatabaseCore({
      database,
      resolveFileUrl,
    });
  }

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
