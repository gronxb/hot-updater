import { createDatabasePluginCrud } from "./databasePluginCrud";
import { createTransactionDatabasePlugin } from "./databasePluginTransaction";
import type { DatabasePlugin, DatabasePluginImplementation } from "./types";

export {
  DatabasePluginInputError,
  type DatabasePluginInputErrorCode,
} from "./databasePluginCrud";

export interface CreateDatabasePluginOptions {
  readonly name: string;
  readonly plugin: () => DatabasePluginImplementation;
}

export const createDatabasePlugin = (
  options: CreateDatabasePluginOptions,
): DatabasePlugin => {
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
