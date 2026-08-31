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
import { createMongoReads } from "./mongodbReads";
import { createMongoWrites } from "./mongodbWrites";

export interface MongoDBConfig {
  readonly client: MongoClient;
  readonly transactions: true;
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
): DatabasePluginImplementation => {
  const direct = createMongoImplementation(client);
  const transactionOptions = {
    readPreference: "primary" as const,
    readConcern: { level: "snapshot" as const },
    writeConcern: { w: "majority" as const },
  };
  return {
    ...direct,
    create: (input) =>
      input.model !== "bundle_events"
        ? direct.create(input)
        : client.withSession((session) =>
            session.withTransaction(
              () => createMongoImplementation(client, session).create(input),
              transactionOptions,
            ),
          ),
    deleteChannel: (input) =>
      client.withSession((session) =>
        session.withTransaction(
          () => createMongoImplementation(client, session).deleteChannel(input),
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
          () => callback(createMongoImplementation(client, session)),
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
  const adapter = createDatabasePluginAdapter(
    "mongodb",
    createTransactionalMongoImplementation(config.client),
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
