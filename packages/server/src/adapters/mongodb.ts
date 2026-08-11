import type {
  DatabasePluginImplementation,
  TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import { createDatabasePluginAdapter } from "@hot-updater/plugin-core/internal";
import type { ClientSession, MongoClient } from "mongodb";

import { createMongoMigrator } from "../db/fixedMigrator";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import { createMongoCollections } from "./mongodbCollections";
import { createMongoReads } from "./mongodbReads";
import { createMongoWrites } from "./mongodbWrites";

export interface MongoDBConfig {
  readonly client: MongoClient;
  readonly transactions?: boolean;
}

const createMongoImplementation = (
  client: MongoClient,
  session?: ClientSession,
): DatabasePluginImplementation => {
  const collections = createMongoCollections(client);
  return {
    ...createMongoWrites(collections, session),
    ...createMongoReads(collections, session),
  };
};

const createTransactionalMongoImplementation = (
  client: MongoClient,
): DatabasePluginImplementation => ({
  ...createMongoImplementation(client),
  transaction: <TResult>(
    callback: (
      transaction: TransactionDatabasePluginImplementation,
    ) => Promise<TResult>,
  ): Promise<TResult> =>
    client.withSession((session) =>
      session.withTransaction(() =>
        callback(createMongoImplementation(client, session)),
      ),
    ),
});

export const mongoAdapter = (
  config: MongoDBConfig,
): DatabaseAdapterWithCapabilities => {
  const adapter = createDatabasePluginAdapter(
    "mongodb",
    config.transactions === true
      ? createTransactionalMongoImplementation(config.client)
      : createMongoImplementation(config.client),
  );
  return Object.assign(
    createDatabasePlugin({
      name: "mongodb",
      bundles: adapter.bundles,
      bundlePatches: adapter.bundlePatches,
      analytics: adapter.analytics,
      clientAccessKeys: adapter.clientAccessKeys,
      commit: adapter.commit,
      getChannels: adapter.getChannels,
      getUpdateInfo: adapter.getUpdateInfo,
    }),
    {
      adapterName: "mongodb",
      provider: "mongodb" as const,
      createMigrator: () => createMongoMigrator(config.client),
    },
  );
};
