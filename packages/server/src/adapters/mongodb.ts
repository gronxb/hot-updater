import { createDatabasePlugin } from "@hot-updater/plugin-core";
import {
  createDatabasePluginAdapter,
  type DatabasePluginImplementation,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import type { ClientSession, MongoClient } from "mongodb";

import { createMongoMigrator } from "../db/fixedMigrator";
import type { DatabaseAdapterWithCapabilities } from "../db/types";
import { createMongoCollections } from "./mongodbCollections";
import { createMongoInsightsModel } from "./mongodbInsightsModel";
import { isMongoInsightsDatabaseNamespace } from "./mongodbInsightsSourceSchema";
import { createMongoReads } from "./mongodbReads";
import { createMongoWrites } from "./mongodbWrites";

export interface MongoDBConfig {
  readonly client: MongoClient;
  readonly insightsDatabaseNamespace: string;
  readonly transactions: true;
}

const createMongoImplementation = (
  client: MongoClient,
  databaseNamespace: string,
  session?: ClientSession,
): DatabasePluginImplementation => {
  const collections = createMongoCollections(client);
  return {
    insights: createMongoInsightsModel(client, databaseNamespace, session),
    ...createMongoWrites(collections, session),
    ...createMongoReads(collections, session),
  };
};

const createTransactionalMongoImplementation = (
  client: MongoClient,
  databaseNamespace: string,
): DatabasePluginImplementation => {
  const direct = createMongoImplementation(client, databaseNamespace);
  const transactionOptions = {
    readPreference: "primary" as const,
    readConcern: { level: "snapshot" as const },
    writeConcern: { w: "majority" as const },
  };
  return {
    ...direct,
    deleteChannel: (input) =>
      client.withSession((session) =>
        session.withTransaction(
          () =>
            createMongoImplementation(
              client,
              databaseNamespace,
              session,
            ).deleteChannel(input),
          transactionOptions,
        ),
      ),
    transaction: <TResult>(
      callback: (
        transaction: TransactionDatabasePluginImplementation,
      ) => Promise<TResult>,
    ): Promise<TResult> =>
      client.withSession((session) =>
        session.withTransaction(
          () =>
            callback(
              createMongoImplementation(client, databaseNamespace, session),
            ),
          transactionOptions,
        ),
      ),
  };
};

export const mongoAdapter = (
  config: MongoDBConfig,
): DatabaseAdapterWithCapabilities => {
  if (config.transactions !== true) {
    throw new Error(
      "MongoDB Insights requires replica-set or sharded-cluster transactions.",
    );
  }
  if (!isMongoInsightsDatabaseNamespace(config.insightsDatabaseNamespace)) {
    throw new Error(
      "MongoDB Insights database namespace must be a lowercase UUID.",
    );
  }
  const adapter = createDatabasePluginAdapter(
    "mongodb",
    createTransactionalMongoImplementation(
      config.client,
      config.insightsDatabaseNamespace,
    ),
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
