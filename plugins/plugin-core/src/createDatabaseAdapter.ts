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

export interface CreateDatabaseAdapterOptions {
  readonly name: string;
  readonly adapter: () => DatabaseAdapterImplementation;
}

export type DatabaseAdapterBase = Omit<
  DatabaseAdapter,
  typeof databaseAnalyticsSupport | typeof databaseBundleEventService
> & {
  readonly [databaseAnalyticsSupport]?: never;
  readonly [databaseBundleEventService]?: never;
};

export const createDatabaseAdapterBase = (
  options: CreateDatabaseAdapterOptions,
): DatabaseAdapterBase => {
  const implementation = options.adapter();
  const transaction = implementation.transaction;
  return {
    ...createDatabaseAdapterCrud(implementation),
    name: options.name,
    ...(implementation.getChannels
      ? { getChannels: implementation.getChannels }
      : {}),
    ...(implementation.getUpdateInfo
      ? { getUpdateInfo: implementation.getUpdateInfo }
      : {}),
    ...(transaction
      ? {
          transaction: (callback) =>
            transaction((rawTransaction) =>
              callback(createTransactionDatabaseAdapter(rawTransaction)),
            ),
        }
      : {}),
    ...(implementation.onUnmount
      ? { onUnmount: implementation.onUnmount }
      : {}),
  };
};

export const createDatabaseAdapter = (
  options: CreateDatabaseAdapterOptions,
): DatabaseAdapter => ({
  ...createDatabaseAdapterBase(options),
  [databaseAnalyticsSupport]: true,
});
