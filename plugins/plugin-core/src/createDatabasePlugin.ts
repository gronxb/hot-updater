import { createDatabasePluginCrud } from "./databasePluginCrud";
import { createTransactionDatabasePlugin } from "./databasePluginTransaction";
import {
  databaseAnalyticsSupport,
  databaseBundleEventService,
  type DatabasePlugin,
  type DatabasePluginImplementation,
} from "./types";

export {
  DatabasePluginInputError,
  type DatabasePluginInputErrorCode,
} from "./databasePluginCrud";

export interface CreateDatabasePluginOptions {
  readonly name: string;
  readonly plugin: () => DatabasePluginImplementation;
}

export type DatabasePluginBase = Omit<
  DatabasePlugin,
  typeof databaseAnalyticsSupport | typeof databaseBundleEventService
> & {
  readonly [databaseAnalyticsSupport]?: never;
  readonly [databaseBundleEventService]?: never;
};

export const createDatabasePluginBase = (
  options: CreateDatabasePluginOptions,
): DatabasePluginBase => {
  const implementation = options.plugin();
  const transaction = implementation.transaction;
  return {
    ...createDatabasePluginCrud(implementation),
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
              callback(createTransactionDatabasePlugin(rawTransaction)),
            ),
        }
      : {}),
    ...(implementation.onUnmount
      ? { onUnmount: implementation.onUnmount }
      : {}),
  };
};

export const createDatabasePlugin = (
  options: CreateDatabasePluginOptions,
): DatabasePlugin => ({
  ...createDatabasePluginBase(options),
  [databaseAnalyticsSupport]: true,
});
