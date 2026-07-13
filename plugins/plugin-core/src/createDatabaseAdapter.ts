import {
  createDatabaseAdapterCrud,
  createTransactionDatabaseAdapter,
} from "./databaseAdapterCrud";
import type {
  DatabaseAdapter,
  DatabaseAdapterLifecycleHooks,
  DatabaseAdapterImplementation,
} from "./types";

export {
  DatabaseAdapterInputError,
  type DatabaseAdapterInputErrorCode,
} from "./databaseAdapterCrud";

export interface CreateDatabaseAdapterOptions<TConfig, TContext = unknown> {
  readonly name: string;
  readonly factory: (
    config: TConfig,
  ) => DatabaseAdapterImplementation<TContext>;
}

export type DatabaseAdapterProvider<TConfig, TContext = unknown> = (
  config: TConfig,
  hooks?: DatabaseAdapterLifecycleHooks,
) => DatabaseAdapter<TContext>;

export const createDatabaseAdapter = <TConfig, TContext = unknown>(
  options: CreateDatabaseAdapterOptions<TConfig, TContext>,
): DatabaseAdapterProvider<TConfig, TContext> => {
  return (config, hooks) => {
    const implementation = options.factory(config);
    const transaction = implementation.transaction;
    return {
      ...createDatabaseAdapterCrud(implementation),
      name: options.name,
      ...(implementation.getUpdateInfo
        ? { getUpdateInfo: implementation.getUpdateInfo }
        : {}),
      ...(transaction
        ? {
            transaction: (callback, context) =>
              transaction(
                (rawTransaction) =>
                  callback(createTransactionDatabaseAdapter(rawTransaction)),
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
