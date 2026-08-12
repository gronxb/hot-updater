import type {
  HotUpdaterContext,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";
import { assertRuntimeStoragePlugin } from "@hot-updater/plugin-core";

import { createAnalyticsProvider } from "./analytics/bounded/provider";
import type { AnalyticsQueryAccess } from "./analytics/routes";
import type { AnalyticsProvider } from "./analytics/types";
import { authenticateClientAccessKey } from "./clientAccessKeys";
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

export interface CreateHotUpdaterFeatures {
  /**
   * Mount Analytics ingestion and query routes backed by
   * `database.analytics`. Protected queries are the default.
   */
  readonly analytics?:
    | boolean
    | {
        /** Query routes deny access by default; client access keys never grant query access. */
        readonly queryAccess?: AnalyticsQueryAccess;
      };
  /**
   * Protect update-check and Analytics ingestion routes with `x-api-key`,
   * using `database.clientAccessKeys` for authentication.
   */
  readonly clientAccessKeys?: boolean;
}

export interface CreateHotUpdaterOptions<TContext = undefined> {
  readonly database: DatabasePlugin;
  /**
   * Optional server features. These are independent from `routes`, which only
   * controls the core update-check and bundle-management route groups.
   */
  readonly features?: CreateHotUpdaterFeatures;
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
  analytics: CreateHotUpdaterFeatures["analytics"],
): AnalyticsQueryAccess | undefined => {
  if (analytics === undefined || analytics === false) return undefined;
  if (analytics === true) return "protected";
  if (typeof analytics !== "object" || analytics === null) {
    throw new TypeError(
      "The Analytics feature must be a boolean or an options object.",
    );
  }
  const queryAccess = analytics.queryAccess ?? "protected";
  if (queryAccess !== "protected" && queryAccess !== "public") {
    throw new TypeError("Invalid Analytics queryAccess option.");
  }
  return queryAccess;
};

const normalizeClientAccessKeys = (
  clientAccessKeys: CreateHotUpdaterFeatures["clientAccessKeys"],
): boolean => {
  if (clientAccessKeys === undefined) return false;
  if (typeof clientAccessKeys !== "boolean") {
    throw new TypeError("Client access-keys option must be a boolean.");
  }
  return clientAccessKeys;
};

const normalizeFeatures = (
  features: CreateHotUpdaterOptions["features"],
): CreateHotUpdaterFeatures => {
  if (features === undefined) return {};
  if (typeof features !== "object" || features === null) {
    throw new TypeError("Features must be an object.");
  }
  return features;
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
  const features = normalizeFeatures(options.features);
  const analyticsQueryAccess = normalizeAnalyticsQueryAccess(
    features.analytics,
  );
  const clientAccessKeysEnabled = normalizeClientAccessKeys(
    features.clientAccessKeys,
  );
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
    clientAccessKeysEnabled
      ? {
          authenticate: (request) =>
            authenticateClientAccessKey({
              beforeLookup: assertSchemaReady,
              clientAccessKeys: plugin.clientAccessKeys,
              request,
            }),
        }
      : undefined,
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
