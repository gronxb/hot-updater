import {
  assertStorageOperations,
  type StoragePlugin,
} from "@hot-updater/plugin-core";

import { createAnalyticsProvider } from "./analytics/bounded/provider";
import type { AnalyticsProvider } from "./analytics/types";
import {
  authenticateClientAccessKey,
  normalizeClientAccessKeyHeaderName,
} from "./clientAccessKeys";
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

export type ClientAccessPolicy =
  | {
      /**
       * Leaves Release Catalog, artifact, and Analytics ingestion routes
       * publicly accessible without a client credential.
       */
      readonly type: "public";
    }
  | {
      /**
       * Requires a key registered in `database.models.clientAccessKeys` for
       * Release Catalog, artifact, and Analytics ingestion requests.
       */
      readonly type: "api-key";
      /**
       * Request header containing the client access key. Defaults to
       * `x-api-key`. Clients must send the same header; Release Catalog
       * responses include it in `Vary` to preserve cache isolation.
       */
      readonly headerName?: string;
    };

export interface CreateHotUpdaterOptions {
  /** Stable project/server identity used to isolate Release catalog history. */
  readonly authorityId?: string;
  readonly database: DatabasePlugin;
  /**
   * Required client-route access policy. This choice is explicit so a server
   * cannot accidentally change between public and authenticated OTA access.
   * `/version`, storage downloads, and admin-handler routes are unaffected.
   */
  readonly clientAccess: ClientAccessPolicy;
  /** Storage implementations used to read provider-specific storage URIs. */
  readonly storage?: readonly StoragePlugin[];
}

const normalizeClientAccess = (
  value: unknown,
):
  | { readonly type: "public" }
  | {
      readonly type: "api-key";
      readonly headerName: string;
    } => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("clientAccess must be an object.");
  }
  const policy = value as {
    readonly headerName?: unknown;
    readonly type?: unknown;
  };
  if (policy.type === "public") return { type: "public" };
  if (policy.type === "api-key") {
    return {
      headerName: normalizeClientAccessKeyHeaderName(policy.headerName),
      type: "api-key",
    };
  }
  throw new TypeError(
    'clientAccess.type must be either "public" or "api-key".',
  );
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
  const clientAccess = normalizeClientAccess(options.clientAccess);
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
    clientAccess.type === "api-key"
      ? {
          authenticate: (request) =>
            authenticateClientAccessKey({
              beforeLookup: assertSchemaReady,
              clientAccessKeys: plugin.models.clientAccessKeys,
              headerName: clientAccess.headerName,
              request,
            }),
          headerName: clientAccess.headerName,
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
