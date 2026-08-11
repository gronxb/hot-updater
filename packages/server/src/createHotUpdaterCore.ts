import type {
  HotUpdaterContext,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";
import { assertRuntimeStoragePlugin } from "@hot-updater/plugin-core";

import { createAnalyticsProvider } from "./analytics/bounded/provider";
import type { AnalyticsQueryAccess } from "./analytics/routes";
import type { AnalyticsProvider } from "./analytics/types";
import { createDatabasePluginCore } from "./db/databasePluginCore";
import { createSchemaReadinessChecker } from "./db/schemaReadiness";
import {
  type DatabasePlugin,
  type DatabaseAdapterCapabilities,
  type DatabaseAPI,
  isDatabasePlugin,
  type StoragePluginFactory,
} from "./db/types";
import { createHotUpdaterHandler, type HandlerRoutes } from "./handler";
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
    readonly analytics?: AnalyticsProvider;
  };

export type HotUpdaterAPI<TContext = undefined> =
  RuntimeHotUpdaterAPI<TContext>;

export interface CreateHotUpdaterOptions<TContext = undefined> {
  readonly database: DatabasePlugin;
  readonly analytics?: {
    /** Query routes deny access until client access-key auth is configured. */
    readonly queryAccess?: AnalyticsQueryAccess;
  };
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

const normalizeAnalyticsQueryAccess = (
  analytics: CreateHotUpdaterOptions["analytics"],
): AnalyticsQueryAccess | undefined => {
  if (analytics === undefined) return undefined;
  if (typeof analytics !== "object" || analytics === null) {
    throw new TypeError("Analytics options must be an object.");
  }
  const queryAccess = analytics.queryAccess ?? "protected";
  if (queryAccess !== "protected" && queryAccess !== "public") {
    throw new TypeError("Invalid Analytics queryAccess option.");
  }
  return queryAccess;
};

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
  readonly core: DatabasePluginCore<TContext>;
};

export type HotUpdaterCore<TContext = undefined> = {
  readonly api: RuntimeHotUpdaterAPI<TContext>;
  readonly adapterCapabilities: DatabaseAdapterCapabilities;
  readonly core: DatabasePluginCore<TContext>;
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
  const analyticsQueryAccess = normalizeAnalyticsQueryAccess(options.analytics);
  const analytics =
    analyticsQueryAccess === undefined
      ? undefined
      : createAnalyticsProvider({
          async append(row) {
            await assertSchemaReady();
            return plugin.analytics.append(row);
          },
          async scan(input) {
            await assertSchemaReady();
            return plugin.analytics.scan(input);
          },
        });

  const internalHandler = createHotUpdaterHandler(
    core.api,
    {
      basePath,
      routes: options.routes,
    },
    analytics === undefined
      ? undefined
      : {
          provider: analytics,
          queryAccess: analyticsQueryAccess ?? "protected",
        },
  );

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
      ...(analytics === undefined ? {} : { analytics }),
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
