import type {
  HotUpdaterContext,
  RuntimeStoragePlugin,
  UniversalComponentDataAdapter,
  UniversalComponentDataSource,
  UniversalComponentSchema,
} from "@hot-updater/plugin-core";
import {
  assertRuntimeStoragePlugin,
  universalComponentDataAdapterCapability,
} from "@hot-updater/plugin-core";

import { createDatabasePluginCore } from "./db/databasePluginCore";
import { createSchemaReadinessChecker } from "./db/schemaReadiness";
import {
  type DatabasePlugin,
  type DatabaseAdapterCapabilities,
  type DatabaseAPI,
  isDatabasePlugin,
  type StoragePluginFactory,
} from "./db/types";
import {
  createHandler,
  createRuntimeHandler,
  type HandlerRoutes,
} from "./handler";
import type { UniversalComponentRegistry } from "./kernel/componentRegistry";
import { composeServerKernel } from "./kernel/composer";
import type { HotUpdaterServerPlugin } from "./kernel/contracts";
import { createCoreServerRoutes } from "./kernel/coreRoutes";
import { executeKernelRequest } from "./kernel/execute";
import { createGuardedInfrastructureRuntime } from "./kernel/guardedRuntime";
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
  readonly database: DatabasePlugin;
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
  /** Trusted in-process server code. Plugins are not sandboxed. */
  readonly plugins?: readonly HotUpdaterServerPlugin[];
}

type DatabasePluginCore<TContext> = {
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
  readonly components?: UniversalComponentRegistry;
  readonly core: DatabasePluginCore<TContext>;
  readonly universalComponentDataAdapter?: UniversalComponentDataAdapter;
};

export type HotUpdaterCore<TContext = undefined> = {
  readonly api: RuntimeHotUpdaterAPI<TContext>;
  readonly adapterCapabilities: DatabaseAdapterCapabilities;
  readonly components?: UniversalComponentRegistry;
  readonly core: DatabasePluginCore<TContext>;
  readonly universalComponentDataAdapter?: UniversalComponentDataAdapter;
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

export function requireUniversalComponentDataSource(
  hotUpdater: RuntimeHotUpdaterAPI,
  schema: UniversalComponentSchema,
): UniversalComponentDataSource {
  const source = getHotUpdaterCoreMetadata(hotUpdater)?.components?.get(schema);
  if (source === undefined) {
    throw new Error(
      `Universal component data source is not available for ${schema.id}.`,
    );
  }
  return source;
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

  if (!isDatabasePlugin(database)) {
    throw new Error("@hot-updater/server only supports database plugins.");
  }

  const plugin: DatabasePlugin = database;
  const adapterName = adapterCapabilities.adapterName ?? plugin.name;
  const assertSchemaReady = createSchemaReadinessChecker(
    adapterName,
    adapterCapabilities.createMigrator,
  );
  const core = createDatabasePluginCore<TContext>(plugin, resolveFileUrl, {
    beforeOperation: assertSchemaReady,
    readStorageText,
  });

  const plugins = options.plugins ?? [];
  const usesKernel = plugins.length > 0;
  const internalHandler = (usesKernel ? createRuntimeHandler : createHandler)(
    core.api,
    {
      basePath,
      routes: options.routes,
    },
  );
  const kernel = (() => {
    if (!usesKernel) return undefined;
    const runtime = createGuardedInfrastructureRuntime({
      beforeDatabaseOperation: assertSchemaReady,
      database: plugin,
      storages: storagePlugins,
    });
    return composeServerKernel({
      carriers: [plugin, ...storagePlugins],
      coreRoutes: createCoreServerRoutes({
        handler: internalHandler,
        routes: options.routes,
      }),
      databaseCarrier: plugin,
      plugins,
      runtime,
    });
  })();
  const requestHandler = (() => {
    if (kernel === undefined) return internalHandler;
    return (
      request: Request,
      context?: HotUpdaterContext<TContext>,
    ): Promise<Response> =>
      executeKernelRequest({
        authentication: kernel.authentication,
        basePath,
        platformContext: context,
        request,
        router: kernel.router,
      });
  })();
  const componentMetadata =
    kernel === undefined || kernel.components.schemas.length === 0
      ? {}
      : {
          components: kernel.components,
          universalComponentDataAdapter: kernel.capabilities.require(
            universalComponentDataAdapterCapability,
          ),
        };

  // Some framework adapters strip the mounted base path or pass extra
  // bindings/execution context arguments. Ignore those extras here so the
  // handler can still be mounted directly as a plain Request handler.
  const handler: RuntimeHotUpdaterAPI<TContext>["handler"] = (
    request,
    context,
    ...extraArgs: unknown[]
  ) => {
    if (extraArgs.length > 0) {
      return requestHandler(request);
    }

    return requestHandler(request, context);
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
      ...componentMetadata,
      core,
    } satisfies HotUpdaterCoreMetadata<TContext>,
  });

  return {
    api,
    adapterCapabilities,
    ...componentMetadata,
    core,
  };
}

export function createHotUpdater<TContext = undefined>(
  options: CreateHotUpdaterOptions<TContext>,
): RuntimeHotUpdaterAPI<TContext> {
  return createHotUpdaterCore(options).api;
}
