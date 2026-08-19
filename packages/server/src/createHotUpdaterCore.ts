import {
  assertStorageOperations,
  type StoragePlugin,
} from "@hot-updater/plugin-core";

import { createAnalyticsProvider } from "./analytics/bounded/provider";
import type { AnalyticsProvider } from "./analytics/types";
import { authenticateClientAccessKey } from "./clientAccessKeys";
import { createDatabasePluginCore } from "./db/databasePluginCore";
import { createSchemaReadinessChecker } from "./db/schemaReadiness";
import {
  type DatabaseAdapterCapabilities,
  type DatabaseAPI,
  type DatabasePlugin,
  isDatabasePlugin,
} from "./db/types";
import {
  createHotUpdaterHandlers,
  type HandlerFeatures,
  type HotUpdaterHandlers,
} from "./handler";
import { normalizeBasePath } from "./route";
import { createStorageAccess } from "./storageAccess";

export type RuntimeHotUpdaterAPI = DatabaseAPI & {
  readonly authorityId: string;
  readonly clientBasePath: string;
  readonly handlers: HotUpdaterHandlers;
  readonly adapterName: string;
  readonly analytics?: AnalyticsProvider;
};

export type HotUpdaterAPI = RuntimeHotUpdaterAPI;

export interface CreateHotUpdaterFeatures extends HandlerFeatures {
  /** Mount Analytics ingestion on the client handler and queries on admin. */
  readonly analytics?: boolean;
  /** Protect update-check and Analytics ingestion routes with `x-api-key`. */
  readonly clientAccessKeys?: boolean;
}

export interface CreateHotUpdaterOptions {
  /** Stable project/server identity used to isolate Release catalog history. */
  readonly authorityId?: string;
  readonly database: DatabasePlugin;
  /** Optional route and domain features. */
  readonly features?: CreateHotUpdaterFeatures;
  /** Storage implementations used to read provider-specific storage URIs. */
  readonly storage?: readonly StoragePlugin[];
  /** External path where `handlers.client` is mounted, used in storage URLs. */
  readonly clientBasePath?: string;
}

const normalizeClientAccessKeys = (
  clientAccessKeys: CreateHotUpdaterFeatures["clientAccessKeys"],
): boolean => {
  if (clientAccessKeys === undefined) return false;
  if (typeof clientAccessKeys !== "boolean") {
    throw new TypeError("Client access-keys feature must be a boolean.");
  }
  return clientAccessKeys;
};

const normalizeBooleanFeature = (
  value: boolean | undefined,
  name: string,
  defaultValue: boolean,
): boolean => {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} feature must be a boolean.`);
  }
  return value;
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
  const authorityId = options.authorityId ?? "default";
  const clientBasePath = normalizeBasePath(options.clientBasePath ?? "/");
  const storagePlugins = (options.storage ?? []).map((storage) => {
    assertStorageOperations(storage, ["get", "getDownloadUrl"]);
    return storage;
  });
  const { downloadStorageObject, readStorageText, resolveFileUrl } =
    createStorageAccess(storagePlugins, { clientBasePath });
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
    authorityId,
    beforeOperation: assertSchemaReady,
    readStorageText,
  });
  const features = normalizeFeatures(options.features);
  const updateCheckEnabled = normalizeBooleanFeature(
    features.updateCheck,
    "Update-check",
    true,
  );
  const analyticsEnabled = normalizeBooleanFeature(
    features.analytics,
    "Analytics",
    false,
  );
  const clientAccessKeysEnabled = normalizeClientAccessKeys(
    features.clientAccessKeys,
  );
  const analytics = !analyticsEnabled
    ? undefined
    : createAnalyticsProvider({
        async append(row) {
          await assertSchemaReady();
          return plugin.models.analytics.append(row);
        },
        async scan(input) {
          await assertSchemaReady();
          return plugin.models.analytics.scan(input);
        },
      });

  const handlers = createHotUpdaterHandlers(
    core.api,
    {
      authorityId,
      features: {
        updateCheck: updateCheckEnabled,
      },
    },
    analytics,
    clientAccessKeysEnabled
      ? {
          authenticate: (request) =>
            authenticateClientAccessKey({
              beforeLookup: assertSchemaReady,
              clientAccessKeys: plugin.models.clientAccessKeys,
              request,
            }),
        }
      : undefined,
    downloadStorageObject,
  );

  const api: RuntimeHotUpdaterAPI = Object.assign(
    {
      authorityId,
      clientBasePath,
      adapterName: adapterCapabilities.adapterName ?? core.adapterName,
      ...(analytics === undefined ? {} : { analytics }),
      handlers,
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
