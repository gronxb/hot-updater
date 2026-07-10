import {
  type DatabasePluginDeclaration,
  normalizeDatabaseDeclaration,
} from "./databaseConnectionSpec";
import {
  createDatabaseRuntime,
  databaseRuntimeFactorySymbol,
} from "./databaseRuntime";
import type {
  DatabasePluginHandle,
  DatabasePluginLifecycleHooks,
  DatabasePluginRuntime,
  MaybePromise,
} from "./types";

type DatabasePluginDeclarationResult = MaybePromise<DatabasePluginDeclaration>;
type DatabaseRuntimeFactory = () => MaybePromise<DatabasePluginRuntime>;
type DatabasePluginRuntimeHandle = DatabasePluginRuntime & DatabasePluginHandle;

export interface DatabasePluginSpec<TConfig = unknown> {
  readonly name: string;
  readonly connect: (config: TConfig) => DatabasePluginDeclarationResult;
}

type SyncDatabasePluginSpec<TConfig> = {
  readonly name: string;
  readonly connect: (config: TConfig) => DatabasePluginDeclaration;
};

type AsyncDatabasePluginSpec<TConfig> = {
  readonly name: string;
  readonly connect: (config: TConfig) => PromiseLike<DatabasePluginDeclaration>;
};

type DatabasePluginCreator<TConfig> = (
  config: TConfig,
  hooks?: DatabasePluginLifecycleHooks,
) => DatabasePluginRuntimeHandle | Promise<DatabasePluginRuntimeHandle>;

const isPromiseLike = <TValue>(
  value: TValue | PromiseLike<TValue>,
): value is PromiseLike<TValue> =>
  typeof (value as { readonly then?: unknown }).then === "function";

const attachRuntimeFactory = (
  runtime: DatabasePluginRuntime,
  openRuntime: DatabaseRuntimeFactory,
): DatabasePluginRuntime => {
  Object.defineProperty(runtime, databaseRuntimeFactorySymbol, {
    enumerable: false,
    value: openRuntime,
  });
  return runtime;
};

export function createDatabasePlugin<TConfig>(
  options: AsyncDatabasePluginSpec<TConfig>,
): (
  config: TConfig,
  hooks?: DatabasePluginLifecycleHooks,
) => Promise<DatabasePluginRuntimeHandle>;
export function createDatabasePlugin<TConfig>(
  options: SyncDatabasePluginSpec<TConfig>,
): (
  config: TConfig,
  hooks?: DatabasePluginLifecycleHooks,
) => DatabasePluginRuntimeHandle;
export function createDatabasePlugin<TConfig>(
  options: DatabasePluginSpec<TConfig>,
): DatabasePluginCreator<TConfig> {
  return createDatabasePluginCreator(options);
}

const createDatabasePluginCreator = <TConfig>(
  options: DatabasePluginSpec<TConfig>,
): DatabasePluginCreator<TConfig> => {
  return (config: TConfig, hooks?: DatabasePluginLifecycleHooks) => {
    const connectedCore = options.connect(config);
    const createRuntimeForCore = (
      connection: DatabasePluginDeclaration,
    ): DatabasePluginRuntimeHandle => {
      const core = normalizeDatabaseDeclaration(connection);
      const getCore = () => Promise.resolve(core);
      const openRuntime = (): DatabasePluginRuntime =>
        createDatabaseRuntime({
          name: options.name,
          getCore,
          hasBundleEvents: core.bundleEvents !== undefined,
          hasUpdateInfo: core.updateInfo !== undefined,
          hooks,
        });
      return attachRuntimeFactory(
        openRuntime(),
        openRuntime,
      ) as DatabasePluginRuntimeHandle;
    };

    if (isPromiseLike(connectedCore)) {
      return Promise.resolve(connectedCore).then(createRuntimeForCore);
    }

    return createRuntimeForCore(connectedCore);
  };
};

export function createLegacyDatabasePlugin<TConfig>(
  options: AsyncDatabasePluginSpec<TConfig>,
): (
  config: TConfig,
  hooks?: DatabasePluginLifecycleHooks,
) => Promise<DatabasePluginRuntimeHandle>;
export function createLegacyDatabasePlugin<TConfig>(
  options: SyncDatabasePluginSpec<TConfig>,
): (
  config: TConfig,
  hooks?: DatabasePluginLifecycleHooks,
) => DatabasePluginRuntimeHandle;
export function createLegacyDatabasePlugin<TConfig>(
  options: DatabasePluginSpec<TConfig>,
): DatabasePluginCreator<TConfig> {
  return createDatabasePluginCreator(options);
}
