import type {
  HotUpdaterContext,
  StoragePlugin,
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
import { normalizeBasePath } from "./route";

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
  storages?: (StoragePlugin<TContext> | StoragePluginFactory<TContext>)[];
  storagePlugins?: (StoragePlugin<TContext> | StoragePluginFactory<TContext>)[];
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
    (plugin) => (typeof plugin === "function" ? plugin() : plugin),
  );

  const resolveStoragePluginUrl = async (
    storageUri: string | null,
    context?: HotUpdaterContext<TContext>,
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

  if (!isDatabasePluginFactory(database) && !isDatabasePlugin(database)) {
    throw new Error(
      "@hot-updater/server/runtime only supports database plugins.",
    );
  }

  const plugin = isDatabasePluginFactory(database) ? database() : database;
  const core = createPluginDatabaseCore<TContext>(
    () => plugin,
    resolveStoragePluginUrl,
    isDatabasePluginFactory(database)
      ? {
          createMutationPlugin: () => database(),
        }
      : undefined,
  );

  const api = {
    ...core.api,
    handler: createHandler(core.api, {
      basePath,
      routes: options.routes,
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
