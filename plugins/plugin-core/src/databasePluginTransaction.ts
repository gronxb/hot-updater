import { createDatabasePluginCrud } from "./databasePluginCrud";
import type {
  DatabasePluginCrud,
  DatabasePluginImplementation,
  TransactionDatabasePluginImplementation,
} from "./types";

export const createTransactionDatabasePlugin = (
  implementation: TransactionDatabasePluginImplementation,
): DatabasePluginCrud => {
  const pluginImplementation: DatabasePluginImplementation = {
    ...implementation,
  };
  return createDatabasePluginCrud(pluginImplementation);
};
