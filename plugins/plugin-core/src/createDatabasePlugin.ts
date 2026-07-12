import {
  createDatabasePluginCrud,
  createTransactionDatabasePlugin,
} from "./createDatabasePluginAdapter";
import type {
  DatabasePlugin,
  DatabasePluginLifecycleHooks,
  DatabasePluginImplementation,
} from "./types";

export {
  DatabasePluginInputError,
  type DatabasePluginInputErrorCode,
} from "./createDatabasePluginAdapter";

export interface CreateDatabasePluginOptions<TConfig, TContext = unknown> {
  readonly name: string;
  readonly factory: (config: TConfig) => DatabasePluginImplementation<TContext>;
}

export type DatabasePluginProvider<TConfig, TContext = unknown> = (
  config: TConfig,
  hooks?: DatabasePluginLifecycleHooks,
) => DatabasePlugin<TContext>;

export const createDatabasePlugin = <TConfig, TContext = unknown>(
  options: CreateDatabasePluginOptions<TConfig, TContext>,
): DatabasePluginProvider<TConfig, TContext> => {
  return (config, hooks) => {
    const implementation = options.factory(config);
    const transaction = implementation.transaction;
    return {
      ...createDatabasePluginCrud(implementation),
      name: options.name,
      ...(implementation.getUpdateInfo
        ? { getUpdateInfo: implementation.getUpdateInfo }
        : {}),
      ...(transaction
        ? {
            transaction: (callback, context) =>
              transaction(
                (rawTransaction) =>
                  callback(createTransactionDatabasePlugin(rawTransaction)),
                context,
              ),
          }
        : {}),
      ...(hooks?.onDatabaseUpdated
        ? { onDatabaseUpdated: hooks.onDatabaseUpdated }
        : {}),
      ...(implementation.onUnmount
        ? { onUnmount: implementation.onUnmount }
        : {}),
    };
  };
};
