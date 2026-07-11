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
type RuntimeOwnerState = "open" | "closing" | "closed";

class DatabaseRuntimeOwnerClosedError extends Error {
  constructor(
    readonly pluginName: string,
    readonly ownerState: Exclude<RuntimeOwnerState, "open">,
  ) {
    super(
      `Database runtime "${pluginName}" cannot be opened while its owner is ${ownerState}.`,
    );
    this.name = "DatabaseRuntimeOwnerClosedError";
  }
}

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
  const initialRuntimeKeys = new Set(Reflect.ownKeys(runtime));
  initialRuntimeKeys.add(databaseRuntimeFactorySymbol);
  const copyExtensionMetadata = (
    openedRuntime: DatabasePluginRuntime,
  ): DatabasePluginRuntime => {
    for (const key of Reflect.ownKeys(runtime)) {
      if (initialRuntimeKeys.has(key)) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(runtime, key);
      if (descriptor) {
        Object.defineProperty(openedRuntime, key, descriptor);
      }
    }
    return openedRuntime;
  };
  const openRuntimeWithMetadata = (): MaybePromise<DatabasePluginRuntime> => {
    const openedRuntime = openRuntime();
    return isPromiseLike(openedRuntime)
      ? Promise.resolve(openedRuntime).then(copyExtensionMetadata)
      : copyExtensionMetadata(openedRuntime);
  };
  Object.defineProperty(runtime, databaseRuntimeFactorySymbol, {
    enumerable: false,
    value: openRuntimeWithMetadata,
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
      let ownerState: RuntimeOwnerState = "open";
      let closePromise: Promise<void> | undefined;
      const createRuntime = (
        close?: () => Promise<void>,
      ): DatabasePluginRuntime =>
        createDatabaseRuntime({
          name: options.name,
          getCore,
          hasBundleEvents: core.bundleEvents !== undefined,
          hasBundleEventRetention:
            core.bundleEvents?.deleteBeforeId !== undefined,
          hasUpdateInfo: core.updateInfo !== undefined,
          hooks,
          ...(close ? { close } : {}),
        });
      const closeOwner = (): Promise<void> => {
        if (closePromise) {
          return closePromise;
        }

        ownerState = "closing";
        closePromise = Promise.resolve()
          .then(() => core.close?.())
          .then(() => undefined)
          .finally(() => {
            ownerState = "closed";
          });
        return closePromise;
      };
      const openBorrowedRuntime = (): DatabasePluginRuntime => {
        if (ownerState !== "open") {
          throw new DatabaseRuntimeOwnerClosedError(options.name, ownerState);
        }
        return createRuntime();
      };
      return attachRuntimeFactory(
        createRuntime(closeOwner),
        openBorrowedRuntime,
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
