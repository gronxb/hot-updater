import { createDatabaseAdapterCrud } from "./databaseAdapterCrud";
import { createTransactionDatabaseAdapter } from "./databaseAdapterTransaction";
import {
  databaseAnalyticsSupport,
  databaseBundleEventService,
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

export type DatabaseAdapterBase<TContext = unknown> = Omit<
  DatabaseAdapter<TContext>,
  typeof databaseAnalyticsSupport | typeof databaseBundleEventService
> & {
  readonly [databaseAnalyticsSupport]?: never;
  readonly [databaseBundleEventService]?: never;
};

export const createDatabaseAdapterBase = <TContext = unknown>(
  options: CreateDatabaseAdapterOptions<TContext>,
): DatabaseAdapterBase<TContext> => {
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
  [databaseAnalyticsSupport]: true,
});
