import type {
  HotUpdaterContext,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";
import { assertRuntimeStoragePlugin } from "@hot-updater/plugin-core";

import { createDatabaseAdapterCore } from "./db/databaseAdapterCore";
import { createSchemaReadinessChecker } from "./db/schemaReadiness";
import {
  type DatabaseAdapter,
  type DatabaseAdapterCapabilities,
  type DatabaseAPI,
  isDatabaseAdapter,
  type StoragePluginFactory,
} from "./db/types";
import {
  createHandler,
  type HandlerEventIngestionOptions,
  type HandlerRoutes,
} from "./handler";
import { normalizeBasePath } from "./route";
import { createStorageAccess } from "./storageAccess";

export type RuntimeHotUpdaterAPI<TContext = undefined> =
  DatabaseAPI<TContext> & {
    readonly basePath: string;
    readonly handler: (
      request: Request,
      context?: HotUpdaterContext<TContext>,
    ) => Promise<Response>;
    readonly adapterName: string;
  };

export type HotUpdaterAPI<TContext = undefined> =
  RuntimeHotUpdaterAPI<TContext>;

export interface CreateHotUpdaterOptions<TContext = undefined> {
  readonly database: DatabaseAdapter;
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
  readonly eventIngestion?: HandlerEventIngestionOptions<TContext>;
  readonly routes?: HandlerRoutes;
}

type DatabaseAdapterCore<TContext> = {
  readonly api: DatabaseAPI<TContext>;
  readonly adapterName: string;
  readonly createMigrator: () => never;
  readonly generateSchema: () => never;
};

export const hotUpdaterCoreMetadata = Symbol.for(
  "@hot-updater/server/core-metadata",
);

export type HotUpdaterCoreMetadata<TContext = undefined> = {
  readonly adapterCapabilities: DatabaseAdapterCapabilities;
  readonly core: DatabaseAdapterCore<TContext>;
};

export type HotUpdaterCore<TContext = undefined> = {
  readonly api: RuntimeHotUpdaterAPI<TContext>;
  readonly adapterCapabilities: DatabaseAdapterCapabilities;
  readonly core: DatabaseAdapterCore<TContext>;
};

export function getHotUpdaterCoreMetadata<TContext = undefined>(
  hotUpdater: RuntimeHotUpdaterAPI<TContext>,
): HotUpdaterCoreMetadata<TContext> | undefined {
  return (
    hotUpdater as RuntimeHotUpdaterAPI<TContext> & {
      readonly [hotUpdaterCoreMetadata]?: HotUpdaterCoreMetadata<TContext>;
    }
  )[hotUpdaterCoreMetadata];
}

export function createHotUpdaterCore<TContext = undefined>(
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
  const adapterCapabilities: DatabaseAdapterCapabilities = database;

  if (!isDatabaseAdapter(database)) {
    throw new Error("@hot-updater/server only supports database adapters.");
  }

  const adapter: DatabaseAdapter = database;
  const adapterName = adapterCapabilities.adapterName ?? adapter.name;
  const assertSchemaReady = createSchemaReadinessChecker(
    adapterName,
    adapterCapabilities.createMigrator,
  );
  const core = createDatabaseAdapterCore<TContext>(adapter, resolveFileUrl, {
    beforeOperation: assertSchemaReady,
    readStorageText,
  });

  const internalHandler = createHandler(core.api, {
    basePath,
    eventIngestion: options.eventIngestion,
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

  const api: RuntimeHotUpdaterAPI<TContext> = Object.assign(
    {
      basePath,
      adapterName: adapterCapabilities.adapterName ?? core.adapterName,
      handler,
    },
    core.api,
  );
  Object.defineProperty(api, hotUpdaterCoreMetadata, {
    enumerable: false,
    value: {
      adapterCapabilities,
      core,
    } satisfies HotUpdaterCoreMetadata<TContext>,
  });

  return {
    api,
    adapterCapabilities,
    core,
  };
}

export function createHotUpdater<TContext = undefined>(
  options: CreateHotUpdaterOptions<TContext>,
): RuntimeHotUpdaterAPI<TContext> {
  return createHotUpdaterCore(options).api;
}
