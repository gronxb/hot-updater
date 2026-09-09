import { createDatabasePlugin } from "@hot-updater/plugin-core";
import {
  createDatabasePluginAdapter,
  type DatabasePluginImplementation,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import {
  MongoServerError,
  type ClientSession,
  type MongoClient,
} from "mongodb";

import { createMongoMigrator } from "../db/fixedMigrator";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import { createMongoCollections } from "./mongodbCollections";
import { createMongoReads } from "./mongodbReads";
import { createMongoWrites } from "./mongodbWrites";

export interface MongoDBConfig {
  readonly client: MongoClient;
  /** Enables atomic catalog commits. Insights always requires MongoDB 5+ on a replica set or sharded cluster. */
  readonly transactions?: boolean;
}

const createMongoImplementation = (
  client: MongoClient,
  session?: ClientSession,
): DatabasePluginImplementation => {
  const collections = createMongoCollections(client);
  return {
    recordInsights: async ({ event }) => {
      const record = () =>
        collections.bundleEvents.updateOne(
          { id: event.id },
          { $setOnInsert: event },
          { upsert: true, collation: { locale: "simple" } },
        );
      try {
        await record();
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 11000)
          throw error;
        await record();
      }
    },
    ...createMongoWrites(collections, session),
    ...createMongoReads(collections, session),
  };
};

const createTransactionalMongoImplementation = (
  client: MongoClient,
): DatabasePluginImplementation => ({
  ...createMongoImplementation(client),
  deleteChannel: (input) =>
    client.withSession((session) =>
      session.withTransaction(() =>
        createMongoImplementation(client, session).deleteChannel(input),
      ),
    ),
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
      models: adapter.models,
      commit: adapter.commit,
    }),
    {
      adapterName: "mongodb",
      provider: "mongodb" as const,
      createMigrator: () => createMongoMigrator(config.client),
    },
  );
};
