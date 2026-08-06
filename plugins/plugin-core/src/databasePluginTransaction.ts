import { createDatabasePluginCrud } from "./databasePluginCrud";
import type {
  DatabasePluginImplementation,
  TransactionDatabasePlugin,
  TransactionDatabasePluginImplementation,
} from "./types";

export const createTransactionDatabasePlugin = (
  implementation: TransactionDatabasePluginImplementation,
): TransactionDatabasePlugin => {
  const pluginImplementation: DatabasePluginImplementation = {
    ...implementation,
  };
  return createDatabasePluginCrud(pluginImplementation);
};
