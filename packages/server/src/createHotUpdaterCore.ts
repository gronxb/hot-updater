import {
  assertStorageOperations,
  type StoragePlugin,
} from "@hot-updater/plugin-core";

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
} from "./db/types";
import { createHotUpdaterHandler, type HandlerRoutes } from "./handler";
import { normalizeBasePath } from "./route";
import {
  createStorageAccess,
  type StorageDeliveryOptions,
} from "./storageAccess";

export type RuntimeHotUpdaterAPI = DatabaseAPI & {
  readonly basePath: string;
  readonly handler: (request: Request) => Promise<Response>;
  readonly adapterName: string;
  readonly analytics?: AnalyticsProvider;
};

export type HotUpdaterAPI = RuntimeHotUpdaterAPI;

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

export interface CreateHotUpdaterOptions {
  readonly database: DatabasePlugin;
  /**
   * Optional server features. These are independent from `routes`, which only
   * controls the core update-check and bundle-management route groups.
   */
  readonly features?: CreateHotUpdaterFeatures;
  readonly storages?: readonly StoragePlugin[];
  /** HTTP delivery for non-HTTP storage URIs returned to update clients. */
  readonly storageDelivery?: StorageDeliveryOptions;
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

type DatabasePluginCore = {
  readonly api: DatabaseAPI;
  readonly adapterName: string;
  readonly createMigrator: () => never;
  readonly generateSchema: () => never;
};

export const hotUpdaterCoreMetadata = Symbol.for(
  "@hot-updater/server/core-metadata",
);

export type HotUpdaterCoreMetadata = {
  readonly adapterCapabilities: DatabaseAdapterCapabilities;
  readonly core: DatabasePluginCore;
};

export type HotUpdaterCore = {
  readonly api: RuntimeHotUpdaterAPI;
  readonly adapterCapabilities: DatabaseAdapterCapabilities;
  readonly core: DatabasePluginCore;
};

export function getHotUpdaterCoreMetadata(
  hotUpdater: RuntimeHotUpdaterAPI,
): HotUpdaterCoreMetadata | undefined {
  return (
    hotUpdater as RuntimeHotUpdaterAPI & {
      readonly [hotUpdaterCoreMetadata]?: HotUpdaterCoreMetadata;
    }
  )[hotUpdaterCoreMetadata];
}

export function createHotUpdaterCore(
  options: CreateHotUpdaterOptions,
): HotUpdaterCore {
  const database = options.database;
  const basePath = normalizeBasePath(options.basePath ?? "/api");
  const storages = (options.storages ?? []).map((storage) => {
    assertStorageOperations(storage, ["get"]);
    return storage;
  });
  const { downloadStorageObject, readStorageText, resolveFileUrl } =
    createStorageAccess(storages, {
      basePath,
      ...options.storageDelivery,
    });
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
  const core = createDatabasePluginCore(plugin, resolveFileUrl, {
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
    downloadStorageObject,
  );

  const handler: RuntimeHotUpdaterAPI["handler"] = (request) =>
    internalHandler(request);

  const api: RuntimeHotUpdaterAPI = Object.assign(
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
    } satisfies HotUpdaterCoreMetadata,
  });

  return {
    api,
    adapterCapabilities,
    core,
  };
}

export function createHotUpdater(
  options: CreateHotUpdaterOptions,
): RuntimeHotUpdaterAPI {
  return createHotUpdaterCore(options).api;
}
