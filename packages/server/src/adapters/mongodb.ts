import type { MongoClient } from "mongodb";

import {
  builtInSchema,
  builtInSettings,
  createEngineDatabase,
} from "../database/builtInDatabase";
import { SETTINGS_TABLE } from "../database/fence";
import { createEngineMigrator } from "../db/engineMigrator";
import type { ToolingDatabase } from "../db/types";
import { createMongoAdapter } from "./mongodbAdapter";

export { MongoTransactionUnsupportedError } from "./mongodbAdapter";

/** Every write runs in a transaction, which needs a replica set or a sharded cluster. */
export interface MongoDBConfig {
  readonly client: MongoClient;
}

/** Settings rows by their `key` field: the engine's rows and a v0 database's alike. */
const readSettings = (client: MongoClient) => async () => {
  const rows = await client
    .db()
    .collection(SETTINGS_TABLE.name)
    .find({ key: { $type: "string" } })
    .toArray();
  return new Map(rows.map((row) => [String(row.key), row.value]));
};

/**
 * Hot Updater's database on MongoDB: the storage engine's MongoDB adapter,
 * fenced by the schema settings. `db migrate` creates the collections and
 * indexes, then writes the settings.
 */
export const mongoAdapter = (config: MongoDBConfig): ToolingDatabase => {
  const adapter = createMongoAdapter({ client: config.client });
  return {
    ...createEngineDatabase({ name: "mongodb", adapter }),
    provider: "mongodb",
    createMigrator: () =>
      createEngineMigrator({
        adapterName: "mongodb",
        adapter,
        schema: builtInSchema,
        settings: builtInSettings,
        readSettings: readSettings(config.client),
      }),
  };
};
