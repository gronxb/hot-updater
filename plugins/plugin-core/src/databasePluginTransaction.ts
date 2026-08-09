import { createDatabasePluginCrud } from "./databasePluginCrud";
import {
  attachDatabasePluginPatchHydration,
  getDatabasePluginPatchHydration,
} from "./internal/databasePatchHydration";
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
  const plugin = createDatabasePluginCrud(pluginImplementation);
  const hydration = getDatabasePluginPatchHydration(implementation);
  return hydration
    ? attachDatabasePluginPatchHydration(plugin, hydration)
    : plugin;
};
