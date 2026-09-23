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
import {
  assemblePlugins,
  HotUpdaterConfigError,
} from "./assembly/assemblePlugins";
import { createDatabasePluginCore } from "./db/databasePluginCore";
import { createSchemaReadinessChecker } from "./db/schemaReadiness";
import {
  type DatabaseAdapterCapabilities,
  type DatabaseAPI,
  type DatabasePlugin,
  isDatabasePlugin,
} from "./db/types";
import {
  type ClientRoutePolicy,
  createHotUpdaterHandlers,
  type HotUpdaterHandlers,
} from "./handler";
import { createInsightsProvider } from "./insights/provider";
import type { InsightsProvider } from "./insights/types";
import type { AnyHotUpdaterPlugin, PluginApis } from "./plugins/definePlugin";
import { createStorageAccess } from "./storageAccess";

export type RuntimeHotUpdaterAPI<
  TPlugins extends readonly AnyHotUpdaterPlugin[] =
    readonly AnyHotUpdaterPlugin[],
> = DatabaseAPI & {
  readonly handlers: HotUpdaterHandlers;
  /** Each plugin's API by plugin id. */
  readonly api: PluginApis<TPlugins>;
  readonly adapterName: string;
  /**
   * Built-in Insights provider. Client ingestion and admin query routes are
   * always mounted; React Native clients report lifecycle events by default
   * and can opt out with `HotUpdater.init({ insights: false })`.
   */
  readonly insights: InsightsProvider;
  /**
   * In-process API key lifecycle operations for trusted server tooling.
   * Creation returns the plaintext once; list and revoke expose only metadata.
   * This capability is never mounted on the client or admin HTTP handlers.
   */
  readonly apiKeys: ApiKeyManagementAPI;
};

export type HotUpdaterAPI = RuntimeHotUpdaterAPI;

export type ClientAccessPolicy =
  /** Leaves client routes public; required when no plugin provides clientAuth. */
  | "public"
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

type ProvidesClientAuth<TPlugin> = TPlugin extends {
  readonly provides?: infer TProvides;
}
  ? TProvides extends { readonly clientAuth: true }
    ? true
    : false
  : false;

type ClientAuthIds<
  TPlugins extends readonly unknown[],
  TFound extends string[] = [],
> = TPlugins extends readonly [infer THead, ...infer TTail]
  ? ClientAuthIds<
      TTail,
      ProvidesClientAuth<THead> extends true
        ? [
            ...TFound,
            THead extends { readonly id: infer TId extends string }
              ? TId
              : string,
          ]
        : TFound
    >
  : TFound;

type JoinIds<TIds extends string[]> = TIds extends [
  infer TFirst extends string,
  ...infer TRest extends string[],
]
  ? TRest extends []
    ? `"${TFirst}"`
    : `"${TFirst}", ${JoinIds<TRest>}`
  : "";

/**
 * Client routes have one policy source: exactly one plugin that provides
 * clientAuth, or an explicit `clientAccess`. Tuples are counted here; an
 * untyped list that may hold a clientAuth plugin is left to startup.
 */
export type ClientAccessRule<TPlugins extends readonly AnyHotUpdaterPlugin[]> =
  number extends TPlugins["length"]
    ? true extends ProvidesClientAuth<TPlugins[number]>
      ? {
          readonly clientAccess?: "Remove clientAccess: a plugin in this list may provide clientAuth";
        }
      : { readonly clientAccess: ClientAccessPolicy }
    : ClientAuthIds<TPlugins> extends []
      ? { readonly clientAccess: ClientAccessPolicy }
      : ClientAuthIds<TPlugins> extends [infer TId extends string]
        ? {
            readonly clientAccess?: `Remove clientAccess: plugin "${TId}" provides clientAuth`;
          }
        : {
            readonly clientAuth: `Keep one clientAuth plugin: ${JoinIds<ClientAuthIds<TPlugins>>} all provide it`;
          };

export type CreateHotUpdaterOptions<
  TPlugins extends readonly AnyHotUpdaterPlugin[] = readonly [],
> = {
  readonly database: DatabasePlugin;
  /** Storage implementations used to read provider-specific storage URIs. */
  readonly storage?: readonly StoragePlugin[];
  /** Built-in and third-party plugins; at most one provides clientAuth. */
  readonly plugins?: TPlugins;
} & ClientAccessRule<TPlugins>;

const normalizeClientAccess = (
  value: unknown,
):
  | { readonly type: "public" }
  | {
      readonly type: "api-key";
      readonly headerName: string;
    } => {
  if (value === undefined) {
    throw new HotUpdaterConfigError(
      'Set clientAccess to "public", or add a plugin that provides clientAuth.',
    );
  }
  if (value === "public") return { type: "public" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError('clientAccess must be "public" or an object.');
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
  options: CreateHotUpdaterOptions<readonly AnyHotUpdaterPlugin[]>,
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
  const plugins = assemblePlugins(
    options.plugins ?? [],
    adapterCapabilities.engineAdapter,
  );
  const clientAccess =
    plugins.clientAuth === undefined
      ? normalizeClientAccess(
          (options as { readonly clientAccess?: unknown }).clientAccess,
        )
      : undefined;
  if (
    plugins.clientAuth !== undefined &&
    (options as { readonly clientAccess?: unknown }).clientAccess !== undefined
  ) {
    throw new HotUpdaterConfigError(
      `Plugin "${plugins.clientAuth.plugin}" provides clientAuth, so remove clientAccess.`,
    );
  }
  const insightsModel: InsightsModel = {
    async recordEvent(input) {
      await assertSchemaReady();
      return plugin.models.insights.recordEvent(input);
    },
    async listEvents(input) {
      await assertSchemaReady();
      return plugin.models.insights.listEvents(input);
    },
    async findLatestEvents(input) {
      await assertSchemaReady();
      return plugin.models.insights.findLatestEvents(input);
    },
    async countLatestEvents(input) {
      await assertSchemaReady();
      return plugin.models.insights.countLatestEvents(input);
    },
    async countEvents(input) {
      await assertSchemaReady();
      return plugin.models.insights.countEvents(input);
    },
    async getReleaseActivity(input) {
      await assertSchemaReady();
      return plugin.models.insights.getReleaseActivity(input);
    },
    async getAppUsage(input) {
      await assertSchemaReady();
      return plugin.models.insights.getAppUsage(input);
    },
  };
  const insights = createInsightsProvider(insightsModel);
  const apiKeys = createApiKeyManagement({
    apiKeys: plugin.models.apiKeys,
    beforeOperation: assertSchemaReady,
  });

  const clientAuth = plugins.clientAuth;
  const clientPolicy: ClientRoutePolicy | undefined =
    clientAuth !== undefined
      ? {
          varyHeaders: clientAuth.varyHeaders.map((header) =>
            header.toLowerCase(),
          ),
          authenticate: (request) => clientAuth.authenticate(request.headers),
        }
      : clientAccess?.type === "api-key"
        ? {
            varyHeaders: [clientAccess.headerName],
            authenticate: (request) =>
              authenticateApiKey({
                apiKeys: plugin.models.apiKeys,
                beforeLookup: assertSchemaReady,
                headerName: clientAccess.headerName,
                request,
              }),
          }
        : undefined;
  const handlers = createHotUpdaterHandlers(
    core.api,
    insights,
    clientPolicy,
    downloadStorageObject,
    plugins.endpoints,
  );

  const api: RuntimeHotUpdaterAPI = Object.assign(
    {
      adapterName: adapterCapabilities.adapterName ?? core.adapterName,
      insights,
      apiKeys,
      handlers,
      api: plugins.api,
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

export function createHotUpdater<
  const TPlugins extends readonly AnyHotUpdaterPlugin[] = readonly [],
>(
  options: CreateHotUpdaterOptions<TPlugins>,
): RuntimeHotUpdaterAPI<NoInfer<TPlugins>> {
  return createHotUpdaterCore(
    options as CreateHotUpdaterOptions<readonly AnyHotUpdaterPlugin[]>,
  ).api as RuntimeHotUpdaterAPI<TPlugins>;
}
