import {
  assertStorageOperations,
  type InsightsModel,
  type StoragePlugin,
} from "@hot-updater/plugin-core";

import {
  authenticateApiKey,
  createApiKeyManagement,
  normalizeApiKeyHeaderName,
} from "./apiKeys";
import type { ApiKeyManagementAPI } from "./apiKeys";
import { createDatabasePluginCore } from "./db/databasePluginCore";
import { createSchemaReadinessChecker } from "./db/schemaReadiness";
import {
  type DatabaseAdapterCapabilities,
  type DatabaseAPI,
  type DatabasePlugin,
  isDatabasePlugin,
} from "./db/types";
import { createHotUpdaterHandlers, type HotUpdaterHandlers } from "./handler";
import { createValidatedInsightsModel } from "./insights/provider";
import { createStorageAccess } from "./storageAccess";

export type RuntimeHotUpdaterAPI = DatabaseAPI & {
  readonly handlers: HotUpdaterHandlers;
  readonly adapterName: string;
  /**
   * Built-in Insights provider. Client ingestion and admin query routes are
   * always mounted; React Native clients report lifecycle events by default
   * and can opt out with `HotUpdater.init({ insights: false })`.
   */
  readonly insights: InsightsModel;
  /**
   * In-process API key lifecycle operations for trusted server tooling.
   * Creation returns the plaintext once; list and revoke expose only metadata.
   * This capability is never mounted on the client or admin HTTP handlers.
   */
  readonly apiKeys: ApiKeyManagementAPI;
};

export type HotUpdaterAPI = RuntimeHotUpdaterAPI;

export type ClientAccessPolicy =
  | {
      /**
       * Leaves Release Catalog, artifact, and Insights ingestion routes
       * publicly accessible without a client credential.
       */
      readonly type: "public";
    }
  | {
      /**
       * Requires a key registered in `database.models.apiKeys` for
       * Release Catalog, artifact, and Insights ingestion requests.
       */
      readonly type: "api-key";
      /**
       * Request header containing the API key. Defaults to
       * `x-api-key`. Clients must send the same header; Release Catalog
       * responses include it in `Vary` to preserve cache isolation.
       */
      readonly headerName?: string;
    };

export interface CreateHotUpdaterOptions {
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
      headerName: normalizeApiKeyHeaderName(policy.headerName),
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
  for (const key of ["authorityId", "catalogId"]) {
    if (Object.hasOwn(options, key)) {
      throw new TypeError(
        `Remove ${key} from createHotUpdater options. Catalog identity is managed internally.`,
      );
    }
  }
  const database = options.database;
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
    beforeOperation: assertSchemaReady,
    readStorageText,
  });
  const clientAccess = normalizeClientAccess(options.clientAccess);
  const insights = createValidatedInsightsModel(
    plugin.models.insights,
    assertSchemaReady,
  );
  const apiKeys = createApiKeyManagement({
    apiKeys: plugin.models.apiKeys,
    beforeOperation: assertSchemaReady,
  });

  const handlers = createHotUpdaterHandlers(
    core.api,
    insights,
    clientAccess.type === "api-key"
      ? {
          authenticate: (request) =>
            authenticateApiKey({
              apiKeys: plugin.models.apiKeys,
              beforeLookup: assertSchemaReady,
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
      adapterName: adapterCapabilities.adapterName ?? core.adapterName,
      insights,
      apiKeys,
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
