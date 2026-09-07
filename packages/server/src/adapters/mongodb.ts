import {
  compareInsightsText,
  createDatabasePlugin,
} from "@hot-updater/plugin-core";
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
    recordInsights: async (input) => {
      const record = () =>
        client.withSession((recordSession) =>
          recordSession.withTransaction(
            async () => {
              const records = createMongoCollections(client);
              const options = {
                session: recordSession,
                collation: { locale: "simple" },
              };
              const inserted = await records.bundleEvents.updateOne(
                { id: input.event.id },
                { $setOnInsert: input.event },
                { ...options, upsert: true },
              );
              if (inserted.upsertedCount === 0) return;
              const current = await records.bundleInstallations.findOne(
                { install_id: input.installation.install_id },
                options,
              );
              if (current === null) {
                await records.bundleInstallations.insertOne(
                  { ...input.installation },
                  {
                    session: recordSession,
                  },
                );
              } else if (
                input.installation.received_at_ms > current.received_at_ms ||
                (input.installation.received_at_ms === current.received_at_ms &&
                  compareInsightsText(input.installation.id, current.id) > 0)
              ) {
                await records.bundleInstallations.updateOne(
                  { install_id: input.installation.install_id },
                  { $set: input.installation },
                  options,
                );
              }
            },
            {
              readConcern: { level: "snapshot" },
              readPreference: "primary",
              writeConcern: { w: "majority" },
            },
          ),
        );
      try {
        await record();
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 11000)
          throw error;
        // A concurrent insert won a canonical key. Read that committed winner
        // in a new transaction; some MongoDB versions do not retry E11000.
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
