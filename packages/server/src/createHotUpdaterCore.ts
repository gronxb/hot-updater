import type {
  HotUpdaterContext,
  RuntimeStoragePlugin,
} from "@hot-updater/plugin-core";
import { assertRuntimeStoragePlugin } from "@hot-updater/plugin-core";

import { createCoreServerRoutes } from "./coreRoutes";
import { createDatabasePluginCore } from "./db/databasePluginCore";
import { createSchemaReadinessChecker } from "./db/schemaReadiness";
import {
  type DatabaseAdapterCapabilities,
  type DatabaseAPI,
  type DatabasePlugin,
  isDatabasePlugin,
} from "./db/types";
import type { HandlerOptions } from "./handlerTypes";
import type {
  ProjectedFeatureApis,
  ProjectPlugins,
} from "./kernel/apiProjection";
import { composeServerKernel } from "./kernel/composer";
import { createCoreRouteDescriptors } from "./kernel/coreRoutes";
import { executeKernelRequest } from "./kernel/execute";
import { createGuardedInfrastructureRuntime } from "./kernel/guardedRuntime";
import type { FirstPartyFeatureManifest } from "./kernel/manifest";
import type { CompiledVersionMetadata } from "./kernel/metadata";
import { normalizeBasePath } from "./route";
import { createStorageAccess } from "./storageAccess";

export type RuntimeHotUpdaterAPI<TContext = undefined> =
  DatabaseAPI<TContext> & {
    readonly adapterName: string;
    readonly basePath: string;
    readonly handler: (
      request: Request,
      context?: HotUpdaterContext<TContext>,
    ) => Promise<Response>;
  };

export type HotUpdaterAPI<TContext = undefined> =
  RuntimeHotUpdaterAPI<TContext>;

type RuntimeStorageInput<TContext> =
  | RuntimeStoragePlugin<TContext>
  | (() => RuntimeStoragePlugin<TContext>);

export interface CreateHotUpdaterOptions<
  TContext = undefined,
  TPlugins extends readonly FirstPartyFeatureManifest[] = readonly [],
> extends HandlerOptions {
  readonly database: DatabasePlugin;
  readonly plugins?: TPlugins;
  readonly storages?: readonly RuntimeStorageInput<TContext>[];
}

type DatabasePluginCore<TContext> = {
  readonly api: DatabaseAPI<TContext>;
  readonly adapterName: string;
  readonly createMigrator: () => never;
  readonly generateSchema: () => never;
};

export type HotUpdaterCoreMetadata = {
  readonly adapterCapabilities: DatabaseAdapterCapabilities;
  readonly core: Pick<
    DatabasePluginCore<unknown>,
    "createMigrator" | "generateSchema"
  >;
};

export type HotUpdaterCore<
  TContext = undefined,
  TPlugins extends readonly FirstPartyFeatureManifest[] = readonly [],
> = {
  readonly api: RuntimeHotUpdaterAPI<TContext> &
    Readonly<ProjectPlugins<TPlugins, TContext>>;
  readonly adapterCapabilities: DatabaseAdapterCapabilities;
  readonly core: DatabasePluginCore<TContext>;
};

const coreMetadata = new WeakMap<object, HotUpdaterCoreMetadata>();

export function getHotUpdaterCoreMetadata(
  hotUpdater: object,
): HotUpdaterCoreMetadata | undefined {
  return coreMetadata.get(hotUpdater);
}

type RuntimeFields<TContext> = {
  readonly adapterName: string;
  readonly basePath: string;
  readonly handler: (
    request: Request,
    context?: HotUpdaterContext<TContext>,
  ) => Promise<Response>;
};

function createRuntimeApi<
  TContext,
  TPlugins extends readonly FirstPartyFeatureManifest[],
>(
  coreApi: DatabaseAPI<TContext>,
  fields: RuntimeFields<TContext>,
  projected: ProjectedFeatureApis,
): RuntimeHotUpdaterAPI<TContext> &
  Readonly<ProjectPlugins<TPlugins, TContext>>;
function createRuntimeApi<TContext>(
  coreApi: DatabaseAPI<TContext>,
  fields: RuntimeFields<TContext>,
  projected: ProjectedFeatureApis,
): object {
  return Object.freeze(
    Object.assign(
      {},
      coreApi,
      fields,
      { features: projected.features },
      projected.aliases,
    ),
  );
}

export function createHotUpdaterCore<
  TContext = undefined,
  const TPlugins extends readonly FirstPartyFeatureManifest[] = readonly [],
>(
  options: CreateHotUpdaterOptions<TContext, TPlugins>,
): HotUpdaterCore<TContext, TPlugins> {
  if (!isDatabasePlugin(options.database)) {
    throw new Error("@hot-updater/server only supports database plugins.");
  }
  const database = options.database;
  const storages = (options.storages ?? []).map((storage) =>
    typeof storage === "function" ? storage() : storage,
  );
  storages.forEach(assertRuntimeStoragePlugin);
  const basePath = normalizeBasePath(options.basePath ?? "/api");
  const adapterCapabilities: DatabaseAdapterCapabilities = database;
  const adapterName = adapterCapabilities.adapterName ?? database.name;
  const assertSchemaReady = createSchemaReadinessChecker(
    adapterName,
    adapterCapabilities.createMigrator,
  );
  const { readStorageText, resolveFileUrl } = createStorageAccess(storages);
  const core = createDatabasePluginCore<TContext>(database, resolveFileUrl, {
    beforeOperation: assertSchemaReady,
    readStorageText,
  });
  const runtime = createGuardedInfrastructureRuntime({
    beforeDatabaseOperation: assertSchemaReady,
    database,
    storages,
  });
  const manifests = options.plugins ?? [];
  let metadata: CompiledVersionMetadata | undefined;
  const coreRoutes = createCoreServerRoutes({
    api: core.api,
    descriptors: createCoreRouteDescriptors(options.coreRoutes),
    resolveMetadata: () => metadata,
  });
  const composed = composeServerKernel({
    carriers: [database, ...storages],
    coreApiKeys: [
      ...Object.keys(core.api),
      "adapterName",
      "basePath",
      "features",
      "handler",
    ],
    coreRoutes,
    manifests,
    runtime,
  });
  metadata = composed.metadata;

  const internalHandler = (
    request: Request,
    context?: HotUpdaterContext<TContext>,
  ) =>
    executeKernelRequest({
      authentication: composed.authentication,
      basePath,
      middleware: composed.middleware,
      platformContext: context,
      request,
      router: composed.router,
    });
  const handler: RuntimeFields<TContext>["handler"] = (
    request,
    context,
    ...extraArgs: unknown[]
  ) =>
    extraArgs.length > 0
      ? internalHandler(request)
      : internalHandler(request, context);
  const api = createRuntimeApi<TContext, TPlugins>(
    core.api,
    { adapterName, basePath, handler },
    composed.api,
  );
  coreMetadata.set(api, {
    adapterCapabilities,
    core: {
      createMigrator: core.createMigrator,
      generateSchema: core.generateSchema,
    },
  });
  return Object.freeze({ adapterCapabilities, api, core });
}

export function createHotUpdater<
  TContext = undefined,
  const TPlugins extends readonly FirstPartyFeatureManifest[] = readonly [],
>(
  options: CreateHotUpdaterOptions<TContext, TPlugins>,
): RuntimeHotUpdaterAPI<TContext> &
  Readonly<ProjectPlugins<TPlugins, TContext>> {
  return createHotUpdaterCore(options).api;
}
