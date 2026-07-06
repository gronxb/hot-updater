import {
  createDatabaseRuntime,
  databaseRuntimeFactorySymbol,
  type DatabaseRuntimeFactory,
  type DatabaseRuntimeWithFactory,
} from "./databaseRuntime";
import type {
  DatabasePluginCore,
  DatabasePluginHooks,
  DatabasePluginRuntime,
  MaybePromise,
} from "./types";

type DatabasePluginCoreResult = MaybePromise<DatabasePluginCore>;

export interface DatabasePluginSpec<
  TConfig = unknown,
  TCoreResult extends DatabasePluginCoreResult = DatabasePluginCoreResult,
> {
  readonly name: string;
  readonly connect: (config: TConfig) => TCoreResult;
}

type AwaitedDatabasePluginCore<TCoreResult extends DatabasePluginCoreResult> =
  Awaited<TCoreResult> extends DatabasePluginCore
    ? Awaited<TCoreResult>
    : never;

type RuntimeForConnectResult<TCoreResult extends DatabasePluginCoreResult> =
  TCoreResult extends PromiseLike<unknown>
    ? Promise<
        DatabaseRuntimeWithFactory<AwaitedDatabasePluginCore<TCoreResult>>
      >
    : DatabaseRuntimeWithFactory<AwaitedDatabasePluginCore<TCoreResult>>;

type DatabasePluginCreator<
  TConfig,
  TCoreResult extends DatabasePluginCoreResult,
> = (
  config: TConfig,
  hooks?: DatabasePluginHooks,
) => RuntimeForConnectResult<TCoreResult>;

const toCorePromise = (
  core: MaybePromise<DatabasePluginCore>,
): Promise<DatabasePluginCore> => Promise.resolve(core);

const isPromiseLike = <TValue>(
  value: TValue | PromiseLike<TValue>,
): value is PromiseLike<TValue> =>
  typeof (value as { readonly then?: unknown }).then === "function";

const attachRuntimeFactory = <TCore extends DatabasePluginCore>(
  runtime: DatabasePluginRuntime,
  openRuntime: DatabaseRuntimeFactory,
): DatabaseRuntimeWithFactory<TCore> => {
  Object.defineProperty(runtime, databaseRuntimeFactorySymbol, {
    enumerable: false,
    value: openRuntime,
  });
  return runtime as DatabaseRuntimeWithFactory<TCore>;
};

export function createDatabasePlugin<TConfig, TCore extends DatabasePluginCore>(
  options: DatabasePluginSpec<TConfig, PromiseLike<TCore>>,
): (
  config: TConfig,
  hooks?: DatabasePluginHooks,
) => Promise<DatabaseRuntimeWithFactory<TCore>>;
export function createDatabasePlugin<TConfig, TCore extends DatabasePluginCore>(
  options: DatabasePluginSpec<TConfig, TCore>,
): (
  config: TConfig,
  hooks?: DatabasePluginHooks,
) => DatabaseRuntimeWithFactory<TCore>;
export function createDatabasePlugin<TConfig>(
  options: DatabasePluginSpec<TConfig, DatabasePluginCoreResult>,
): DatabasePluginCreator<TConfig, DatabasePluginCoreResult> {
  return (config: TConfig, hooks?: DatabasePluginHooks) => {
    const connectedCore = options.connect(config);
    const createRuntimeForCore = (
      core: DatabasePluginCore,
    ): DatabaseRuntimeWithFactory => {
      const getCore = () => toCorePromise(core);
      const openRuntime = (): DatabasePluginRuntime =>
        createDatabaseRuntime({
          name: options.name,
          getCore,
          hasBundleEvents: core.bundleEvents !== undefined,
          hasUpdateInfo: core.updateInfo !== undefined,
          hooks,
        });
      return attachRuntimeFactory(openRuntime(), openRuntime);
    };

    if (isPromiseLike(connectedCore)) {
      return Promise.resolve(connectedCore).then(createRuntimeForCore);
    }

    return createRuntimeForCore(connectedCore);
  };
}
