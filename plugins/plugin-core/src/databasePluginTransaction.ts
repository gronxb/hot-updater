import { createDatabasePluginCrud } from "./databasePluginCrud";
import type {
  DatabasePluginCrud,
  TransactionDatabasePluginImplementation,
} from "./types/internal";

export const createTransactionDatabasePlugin = (
  implementation: TransactionDatabasePluginImplementation,
): DatabasePluginCrud => {
  return createDatabasePluginCrud(implementation);
};
