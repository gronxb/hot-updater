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
import { warnDeprecated } from "./deprecations";
import {
  type ClientRoutePolicy,
  createHotUpdaterHandlers,
  type HotUpdaterHandlers,
} from "./handler";
import { createInsightsProvider } from "./insights/provider";
import type { InsightsProvider } from "./insights/types";
import { apiKeys as apiKeysPlugin } from "./plugins/api-keys";
import type {
  AnyHotUpdaterPlugin,
  CoreReader,
  PluginApis,
} from "./plugins/definePlugin";
import { createStorageAccess } from "./storageAccess";

export type RuntimeHotUpdaterAPI<
  TPlugins extends readonly AnyHotUpdaterPlugin[] =
    readonly AnyHotUpdaterPlugin[],
> = DatabaseAPI & {
  readonly handlers: HotUpdaterHandlers;
  /** Core's reads: bundles, Releases, Catalogs, and channels. */
  readonly core: CoreReader;
  /** Each plugin's API by plugin id. */
  readonly api: PluginApis<TPlugins>;
  readonly adapterName: string;
  /**
   * Insights through the database plugin, whether or not `plugins` holds
   * `insights()`.
   * @deprecated Use `hotUpdater.api.insights` from the `insights()` plugin; removed in 1.0.
   */
  readonly insights: InsightsProvider;
  /**
   * In-process API key lifecycle operations for trusted server tooling.
   * Creation returns the plaintext once; list and revoke expose only metadata.
   * This capability is never mounted on the client or admin HTTP handlers.
   * @deprecated Use `hotUpdater.api.apiKeys` from the `apiKeys()` plugin; removed in 1.0.
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
       * @deprecated Use `clientAccess: "public"`; removed in 1.0.
       */
      readonly type: "public";
    }
  | {
      /**
       * Requires a registered API key for Release Catalog, artifact, and
       * Insights ingestion requests, as the `apiKeys()` plugin does.
       * @deprecated Add `apiKeys()` from `@hot-updater/server/plugins/api-keys` to `plugins` instead; removed in 1.0.
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

const WITHOUT_PLUGINS =
  "Without plugins, createHotUpdater serves Insights through the database plugin, which is deprecated and stops in 1.0. Pass plugins: [insights()] from @hot-updater/server/plugins/insights to keep Insights, or plugins: [] to turn it off.";

type ClientAccess =
  | { readonly type: "public" }
  | { readonly type: "api-key"; readonly headerName: string };

/** Reads `clientAccess`; its object forms still work until 1.0, with a warning. */
const parseClientAccess = (value: unknown): ClientAccess | undefined => {
  if (value === undefined) return undefined;
  if (value === "public") return { type: "public" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError('clientAccess must be "public" or an object.');
  }
  const policy = value as {
    readonly headerName?: unknown;
    readonly type?: unknown;
  };
  if (policy.type === "public") {
    warnDeprecated(
      'clientAccess: { type: "public" } is deprecated and stops working in 1.0. Use clientAccess: "public".',
    );
    return { type: "public" };
  }
  if (policy.type === "api-key") {
    const headerName = normalizeApiKeyHeaderName(policy.headerName);
    warnDeprecated(
      `clientAccess: { type: "api-key" } is deprecated and stops working in 1.0. Remove it and add apiKeys(${policy.headerName === undefined ? "" : `{ headerName: "${headerName}" }`}) from @hot-updater/server/plugins/api-keys to plugins, which protects client routes the same way.`,
    );
    return { headerName, type: "api-key" };
  }
  throw new TypeError(
    'clientAccess.type must be either "public" or "api-key".',
  );
};

/** The plugin in a list that declares clientAuth, read before the list is checked. */
const clientAuthPluginOf = (plugins: readonly unknown[]): string | undefined =>
  (
    plugins.find(
      (plugin) =>
        (plugin as { readonly provides?: { readonly clientAuth?: unknown } })
          ?.provides?.clientAuth === true,
    ) as { readonly id?: unknown } | undefined
  )?.id as string | undefined;

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
  // Without plugins, Insights and API keys run through the database plugin until 1.0.
  const legacy = options.plugins === undefined;
  if (legacy) warnDeprecated(WITHOUT_PLUGINS);
  const requested = parseClientAccess(
    (options as { readonly clientAccess?: unknown }).clientAccess,
  );
  const listed: readonly unknown[] = options.plugins ?? [];
  // With plugins, a legacy API-key policy becomes the apiKeys() plugin.
  const mapped =
    !legacy && requested?.type === "api-key" ? requested : undefined;
  const claimed = mapped === undefined ? undefined : clientAuthPluginOf(listed);
  if (claimed !== undefined) {
    throw new HotUpdaterConfigError(
      `Plugin "${claimed}" provides clientAuth, so remove clientAccess.`,
    );
  }
  const plugins = assemblePlugins(
    mapped === undefined
      ? listed
      : [...listed, apiKeysPlugin({ headerName: mapped.headerName })],
    adapterCapabilities.engineAdapter,
    { storage: { readStorageText, resolveFileUrl } },
  );
  if (
    plugins.clientAuth !== undefined &&
    requested !== undefined &&
    mapped === undefined
  ) {
    throw new HotUpdaterConfigError(
      `Plugin "${plugins.clientAuth.plugin}" provides clientAuth, so remove clientAccess.`,
    );
  }
  if (plugins.clientAuth === undefined && requested === undefined) {
    throw new HotUpdaterConfigError(
      'Set clientAccess to "public", or add a plugin that provides clientAuth.',
    );
  }
  const clientAccess = mapped === undefined ? requested : undefined;
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
  // With plugins, the Insights routes are the insights plugin's, or answer that Insights is off.
  const handlers = createHotUpdaterHandlers(
    core.api,
    legacy ? insights : "disabled",
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
      core: plugins.core,
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
