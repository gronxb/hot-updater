import {
  createDatabaseAdapterCrud,
  createTransactionDatabaseAdapter,
} from "./databaseAdapterCrud";
import {
  databaseBundleEventSupport,
  type DatabaseAdapter,
  type DatabaseAdapterImplementation,
} from "./types";

export {
  DatabaseAdapterInputError,
  type DatabaseAdapterInputErrorCode,
} from "./databaseAdapterCrud";

export interface CreateDatabaseAdapterOptions<TContext = unknown> {
  readonly name: string;
  readonly adapter: () => DatabaseAdapterImplementation<TContext>;
}

export const createDatabaseAdapterBase = <TContext = unknown>(
  options: CreateDatabaseAdapterOptions<TContext>,
): DatabaseAdapter<TContext> => {
  const implementation = options.adapter();
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
    ...(implementation.onUnmount
      ? { onUnmount: implementation.onUnmount }
      : {}),
  };
};

export const createDatabaseAdapter = <TContext = unknown>(
  options: CreateDatabaseAdapterOptions<TContext>,
): DatabaseAdapter<TContext> => ({
  ...createDatabaseAdapterBase(options),
  [databaseBundleEventSupport]: true,
});
