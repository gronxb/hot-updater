import {
  StorageConfigurationError,
  type HotUpdaterContext,
} from "@hot-updater/plugin-core";

import { createCoreServerRoutes } from "./coreRoutes";
import { createDatabasePluginCore } from "./db/databasePluginCore";
import { createSchemaReadinessChecker } from "./db/schemaReadiness";
import {
  type DatabaseAdapterCapabilities,
  type DatabaseAPI,
  isDatabasePlugin,
} from "./db/types";
import type { ProjectPlugins } from "./kernel/apiProjection";
import { composeServerKernel } from "./kernel/composer";
import { createCoreRouteDescriptors } from "./kernel/coreRoutes";
import { executeKernelRequest } from "./kernel/execute";
import { createGuardedInfrastructureRuntime } from "./kernel/guardedRuntime";
import type { FirstPartyFeatureManifest } from "./kernel/manifest";
import type { CompiledVersionMetadata } from "./kernel/metadata";
import { normalizeBasePath } from "./route";
import {
  createRuntimeApi,
  type CreateHotUpdaterOptions,
  type RuntimeFields,
  type RuntimeHotUpdaterAPI,
} from "./runtimeApi";
import {
  createDatabaseBoundaryApi,
  featureOperation,
  resolveHandlerOperation,
  runStorageBoundary,
} from "./runtimeBoundary";
import { createRuntimeStorageOwner } from "./runtimeStorageOwner";
import { createStorageAccess, createStorageCallContext } from "./storageAccess";
import {
  StorageInvocationAuthority,
  requireHotUpdaterFeatureInvocation,
  type StorageExecutionContext,
} from "./storageInvocation";

export type {
  CreateHotUpdaterOptions,
  HotUpdaterAPI,
  RuntimeHotUpdaterAPI,
  RuntimeStorageInput,
} from "./runtimeApi";

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
  readonly onUnmount: () => Promise<void>;
};

const coreMetadata = new WeakMap<object, HotUpdaterCoreMetadata>();

export function getHotUpdaterCoreMetadata(
  hotUpdater: object,
): HotUpdaterCoreMetadata | undefined {
  return coreMetadata.get(hotUpdater);
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
  const storageOwner = createRuntimeStorageOwner(options.storages ?? []);
  if (storageOwner.hasV2 && options.storageContext === undefined) {
    storageOwner.rollback();
    throw new StorageConfigurationError(
      "missing-storage-context",
      "Direct Storage v2 plugins require a storageContext resolver.",
    );
  }
  const authority = new StorageInvocationAuthority<TContext>();
  let teardown: Promise<void> | undefined;
  const onUnmount = (): Promise<void> => {
    teardown ??= authority.sealAndDrain().then(() => storageOwner.close());
    return teardown;
  };

  try {
    const database = options.database;
    const storages = storageOwner.entries;
    const basePath = normalizeBasePath(options.basePath ?? "/api");
    const adapterCapabilities: DatabaseAdapterCapabilities = database;
    const adapterName = adapterCapabilities.adapterName ?? database.name;
    const assertSchemaReady = createSchemaReadinessChecker(
      adapterName,
      adapterCapabilities.createMigrator,
    );
    const { readStorageText, resolveFileUrl } = createStorageAccess(storages);
    const rawCore = createDatabasePluginCore<StorageExecutionContext<TContext>>(
      database,
      resolveFileUrl,
      {
        beforeOperation: assertSchemaReady,
        readStorageText,
      },
    );
    const publicCoreApi = createDatabaseBoundaryApi({
      authority,
      raw: rawCore.api,
      resolver: options.storageContext,
    });
    const core: DatabasePluginCore<TContext> = {
      ...rawCore,
      api: publicCoreApi,
    };
    const runtime = createGuardedInfrastructureRuntime({
      beforeDatabaseOperation: assertSchemaReady,
      database,
      resolveStorageInvocation: (token) => authority.resolve(token),
      storages,
    });
    const manifests = options.plugins ?? [];
    let metadata: CompiledVersionMetadata | undefined;
    const coreRoutes = createCoreServerRoutes<
      TContext,
      StorageExecutionContext<TContext>
    >({
      api: rawCore.api,
      descriptors: createCoreRouteDescriptors(options.routes),
      resolveMetadata: () => metadata,
      toDatabaseContext: (context) => {
        const invocation = requireHotUpdaterFeatureInvocation<TContext>(
          Reflect.get(context, "invocation"),
        );
        const resolved = authority.resolve(invocation.storageToken);
        return Object.freeze({
          ...createStorageCallContext(
            resolved.platformContext,
            resolved.storageContext,
          ),
          invocation,
        });
      },
    });
    const composed = composeServerKernel<TContext>({
      carriers: [database, ...storages.map(({ plugin }) => plugin)],
      coreApiKeys: [
        ...Object.keys(publicCoreApi),
        "adapterName",
        "basePath",
        "features",
        "handler",
        "onUnmount",
      ],
      coreRoutes,
      invokeFeature: (request) =>
        runStorageBoundary(
          authority,
          options.storageContext,
          {
            kind: "api",
            operation: featureOperation(
              request.namespace,
              request.member,
              request.invokedAlias,
            ),
            context: request.context,
          },
          ({ invocation }) => {
            const args = [...request.args];
            args[request.metadata.publicArity] = invocation;
            return Reflect.apply(request.raw, undefined, args);
          },
        ),
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
        invokeRoute: (input, callback) => {
          const operation = resolveHandlerOperation<TContext>(
            input.route.id,
            composed.featureRouteOperations,
          );
          if (operation === undefined) return callback(undefined);
          return runStorageBoundary(
            authority,
            options.storageContext,
            {
              kind: "handler",
              request: input.request,
              operation,
              context: input.context,
            },
            ({ invocation }) => callback(invocation),
          );
        },
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
      publicCoreApi,
      { adapterName, basePath, handler, onUnmount },
      composed.api,
    );
    coreMetadata.set(api, {
      adapterCapabilities,
      core: {
        createMigrator: core.createMigrator,
        generateSchema: core.generateSchema,
      },
    });
    return Object.freeze({ adapterCapabilities, api, core, onUnmount });
  } catch (error) {
    storageOwner.rollback();
    throw error;
  }
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
