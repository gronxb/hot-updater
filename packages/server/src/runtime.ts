import type {
  StoragePlugin,
  StorageResolveContext,
} from "@hot-updater/plugin-core";
import { createPluginDatabaseCore } from "./db/pluginCore";
import {
  type DatabaseAdapter,
  type DatabaseAPI,
  isDatabasePlugin,
  isDatabasePluginFactory,
  type StoragePluginFactory,
} from "./db/types";
import { createHandler, type HandlerRoutes } from "./handler";
import { rewriteLegacyExactRequestToCanonical } from "./legacyExactRequest";
import {
  isCanonicalUpdateRoute,
  normalizeBasePath,
  wildcardPattern,
} from "./route";

type HotUpdaterCoreInternal = ReturnType<typeof createPluginDatabaseCore>;

export type HotUpdaterAPI = DatabaseAPI & {
  basePath: string;
  handler: (request: Request) => Promise<Response>;
  adapterName: string;
};

export interface CreateHotUpdaterOptions {
  database: DatabaseAdapter;
  storages?: (StoragePlugin | StoragePluginFactory)[];
  storagePlugins?: (StoragePlugin | StoragePluginFactory)[];
  basePath?: string;
  cwd?: string;
  routes?: HandlerRoutes;
}

export function createHotUpdater(
  options: CreateHotUpdaterOptions,
): HotUpdaterAPI {
  const basePath = normalizeBasePath(options.basePath ?? "/api");
  const storagePlugins = (
    options?.storages ??
    options?.storagePlugins ??
    []
  ).map((plugin) => (typeof plugin === "function" ? plugin() : plugin));

  const resolveStoragePluginUrl = async (
    storageUri: string | null,
    context?: StorageResolveContext,
  ): Promise<string | null> => {
    if (!storageUri) {
      return null;
    }

    const url = new URL(storageUri);
    const protocol = url.protocol.replace(":", "");

    if (protocol === "http" || protocol === "https") {
      return storageUri;
    }

    const plugin = storagePlugins.find(
      (item) => item.supportedProtocol === protocol,
    );

    if (!plugin) {
      throw new Error(`No storage plugin for protocol: ${protocol}`);
    }

    const { fileUrl } = await plugin.getDownloadUrl(storageUri, context);
    if (!fileUrl) {
      throw new Error("Storage plugin returned empty fileUrl");
    }

    return fileUrl;
  };

  if (
    !isDatabasePluginFactory(options.database) &&
    !isDatabasePlugin(options.database)
  ) {
    throw new Error(
      "@hot-updater/server/runtime only supports database plugins.",
    );
  }

  const plugin = isDatabasePluginFactory(options.database)
    ? options.database()
    : options.database;
  const core: HotUpdaterCoreInternal = createPluginDatabaseCore(
    plugin,
    resolveStoragePluginUrl,
  );

  const api = {
    ...core.api,
    handler: createHandler(core.api, {
      basePath,
      routes: options.routes,
    }),
    adapterName: core.adapterName,
  };

  return {
    ...api,
    basePath,
    handler: api.handler,
  };
}

export {
  createHandler,
  isCanonicalUpdateRoute,
  normalizeBasePath,
  rewriteLegacyExactRequestToCanonical,
  wildcardPattern,
};
