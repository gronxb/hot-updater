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
import { createHotUpdaterHandlers, type HotUpdaterHandlers } from "./handler";
import { createStorageAccess } from "./storageAccess";

export type RuntimeHotUpdaterAPI = DatabaseAPI & {
  readonly authorityId: string;
  readonly handlers: HotUpdaterHandlers;
  readonly adapterName: string;
  /**
   * Built-in Analytics provider. Client ingestion and admin query routes are
   * always mounted; React Native clients independently opt into lifecycle
   * reporting with `HotUpdater.init({ analytics: true })`.
   */
  readonly analytics: AnalyticsProvider;
};

export type HotUpdaterAPI = RuntimeHotUpdaterAPI;

/**
 * Client-facing server policy that must be selected explicitly because it
 * changes whether public OTA routes require authentication.
 */
export interface CreateHotUpdaterFeatures {
  /**
   * Requires a registered client access key in the `x-api-key` header for
   * Release Catalog, artifact, and Analytics ingestion requests.
   *
   * This is an authentication policy, not merely access-key storage support.
   * Set this to `false` to keep those client routes public. The `/version`
   * route and every admin-handler route are unaffected.
   */
  readonly clientAccessKeys: boolean;
}

export interface CreateHotUpdaterOptions {
  /** Stable project/server identity used to isolate Release catalog history. */
  readonly authorityId?: string;
  readonly database: DatabasePlugin;
  /**
   * Required client-facing security policy. There is no implicit
   * authentication default.
   */
  readonly features: CreateHotUpdaterFeatures;
  /** Storage implementations used to read provider-specific storage URIs. */
  readonly storage?: readonly StoragePlugin[];
}

const normalizeBooleanFeature = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean.`);
  }
  return value;
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
  const storagePlugins = (options.storage ?? []).map((storage) => {
    assertStorageOperations(storage, ["get", "getDownloadUrl"]);
    return storage;
  });
  const { downloadStorageObject, readStorageText, resolveFileUrl } =
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
  const core = createDatabasePluginCore(plugin, resolveFileUrl, {
    authorityId,
    beforeOperation: assertSchemaReady,
    readStorageText,
  });
  if (
    options.features === null ||
    typeof options.features !== "object" ||
    Array.isArray(options.features)
  ) {
    throw new TypeError("features must be an object.");
  }
  const clientAccessKeysEnabled = normalizeBooleanFeature(
    options.features.clientAccessKeys,
    "features.clientAccessKeys",
  );
  const analytics = createAnalyticsProvider({
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
      adapterName: adapterCapabilities.adapterName ?? core.adapterName,
      analytics,
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
