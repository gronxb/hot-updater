import {
  migrateCoreSchema,
  type PluginTables,
} from "@hot-updater/server/database";

import { adapterOf, type DynamoDBConfig } from "./dynamoDB";

/**
 * Creates the table when it is missing and writes the schema settings of
 * core and `plugins`, the plugins the server runs, which the database checks
 * before its first read. `hot-updater init` runs it in AWS with the managed
 * server's plugins.
 */
export const migrateDynamoDB = async (
  config: DynamoDBConfig,
  plugins: readonly PluginTables[] = [],
) => {
  const { client, adapter } = adapterOf(config);
  try {
    await migrateCoreSchema(adapter, "dynamoDB", plugins);
  } finally {
    client.destroy();
  }
};
