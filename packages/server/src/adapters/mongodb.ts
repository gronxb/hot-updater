import {
  createDatabasePlugin,
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
} from "@hot-updater/plugin-core";
import {
  createDatabasePluginAdapter,
  OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
  type DatabasePluginImplementation,
  type TransactionDatabasePluginImplementation,
} from "@hot-updater/plugin-core/internal";
import type { ClientSession, MongoClient } from "mongodb";

import { createMongoMigrator } from "../db/fixedMigrator";
import { createMongoInsightsModelMaintenance } from "../db/mongoInsightsModel";
import { MONGO_INSIGHTS_PREPARATION_COLLECTION } from "../db/mongoInsightsPreparation";
import { createMongoInsightsSource } from "../db/mongoInsightsSource";
import { HotUpdaterSchemaMigrationRequiredError } from "../db/schemaReadiness";
import type {
  DatabaseAdapterWithCapabilities,
  MigrationResult,
  SchemaProvisioner,
} from "../db/types";
import { HOT_UPDATER_SCHEMA_VERSION } from "../schema/types";
import { createMongoCollections } from "./mongodbCollections";
import { createMongoInsightsModel } from "./mongodbInsightsModel";
import {
  MONGO_INSIGHTS_MODEL_COLLECTIONS,
  MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
  MONGO_INSIGHTS_PROJECTION_STATE_ID,
} from "./mongodbInsightsModelSchema";
import {
  MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
  MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
  MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
  MONGO_INSIGHTS_SOURCE_STATE_ID,
} from "./mongodbInsightsSourceSchema";
import { createMongoReads } from "./mongodbReads";
import { createMongoWrites } from "./mongodbWrites";

export interface MongoDBConfig {
  readonly client: MongoClient;
  readonly transactions?: boolean;
}

const assertMongoCoreSchemaReady = async (client: MongoClient) => {
  const version = await createMongoMigrator(client).getVersion();
  if (version !== HOT_UPDATER_SCHEMA_VERSION) {
    throw new HotUpdaterSchemaMigrationRequiredError("mongodb", version);
  }
};

export const createMongoInsightsSchemaProvisioner = (
  client: MongoClient,
  databaseNamespace: string,
): SchemaProvisioner => {
  const source = createMongoInsightsSource(client, databaseNamespace);
  const maintenance = createMongoInsightsModelMaintenance(
    client,
    databaseNamespace,
  );
  const sourceCollections = [
    MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
    MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
    MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
  ] as const;
  const reservedCollections = [
    MONGO_INSIGHTS_PREPARATION_COLLECTION,
    ...sourceCollections,
    ...MONGO_INSIGHTS_MODEL_COLLECTIONS,
  ] as const;
  const inspect = async <T>(
    operation: () => Promise<T>,
    incompatibleMessage: string,
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof InsightsQueryNotReadyError) &&
        !(error instanceof DatabasePluginInputError)
      )
        throw error;
      throw new Error(incompatibleMessage, { cause: error });
    }
  };
  const inspectLayout = async (): Promise<{ readonly ready: boolean }> => {
    const database = client.db();
    const [metadata, sourceState, projectionState, preparationPhase] =
      await Promise.all([
        database
          .listCollections(
            { name: { $in: [...reservedCollections] } },
            { nameOnly: true },
          )
          .toArray(),
        database
          .collection<{ readonly _id: string; readonly sourceId?: unknown }>(
            MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
          )
          .findOne({ _id: MONGO_INSIGHTS_SOURCE_STATE_ID }),
        database
          .collection<{ readonly _id: string; readonly sourceId?: unknown }>(
            MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
          )
          .findOne({ _id: MONGO_INSIGHTS_PROJECTION_STATE_ID }),
        inspect(
          () => source.inspectPreparationLayout(),
          "MongoDB Insights preparation layout is incompatible.",
        ),
      ]);
    const existing = new Set(metadata.map(({ name }) => name));
    if (sourceState === null) {
      await inspect(
        () => source.inspectUnownedLayout(),
        "MongoDB Insights source collections exist without a safe owning state.",
      );
      if (MONGO_INSIGHTS_MODEL_COLLECTIONS.some((name) => existing.has(name))) {
        throw new Error(
          "MongoDB Insights projection collections exist without a source state.",
        );
      }
      return { ready: false };
    }
    if (
      preparationPhase === "absent" ||
      preparationPhase === "empty" ||
      preparationPhase === "installing"
    ) {
      throw new Error("MongoDB Insights preparation layout is incomplete.");
    }
    if (sourceState.sourceId !== databaseNamespace) {
      throw new Error(
        "MongoDB Insights storage belongs to another database namespace.",
      );
    }
    const sourcePhase = await inspect(
      () => source.inspectLayout(),
      "MongoDB Insights source layout is incompatible.",
    );
    if (projectionState === null) {
      await inspect(
        () => maintenance.inspectUnownedLayout(),
        "MongoDB Insights projection collections exist without a safe owning state.",
      );
      return { ready: false };
    }
    if (projectionState.sourceId !== databaseNamespace) {
      throw new Error(
        "MongoDB Insights storage belongs to another database namespace.",
      );
    }
    const projectionPhase = await inspect(
      () => maintenance.inspectLayout(),
      "MongoDB Insights projection layout is incompatible.",
    );
    if (sourcePhase !== "ready" || projectionPhase !== "ready") {
      return { ready: false };
    }
    try {
      await source.ensureReady();
      await maintenance.ensureReady();
      return { ready: true };
    } catch (error) {
      if (error instanceof InsightsQueryNotReadyError) return { ready: false };
      throw error;
    }
  };
  const isReady = async (): Promise<boolean> => {
    await assertMongoCoreSchemaReady(client);
    return (await inspectLayout()).ready;
  };

  return {
    async plan(): Promise<MigrationResult> {
      if (await isReady()) return { operations: [], execute: async () => {} };
      return {
        operations: [
          {
            type: "custom",
            description: "Provision native MongoDB Insights storage",
          },
        ],
        async execute() {
          await assertMongoCoreSchemaReady(client);
          if ((await inspectLayout()).ready) return;
          await source.prepare({ writersDrained: true });
          for (;;) {
            try {
              await source.ensureReady();
              break;
            } catch (error) {
              if (!(error instanceof InsightsQueryNotReadyError)) throw error;
            }
            const progress = await source.runStep({
              maxItems: 200,
              maxRequests: 512,
            });
            if (progress.state === "failed") {
              throw new Error("MongoDB Insights source provisioning failed.");
            }
          }

          await maintenance.prepare();
          for (;;) {
            try {
              await maintenance.ensureReady();
              break;
            } catch (error) {
              if (!(error instanceof InsightsQueryNotReadyError)) throw error;
            }
            const progress = await maintenance.runStep({
              maxItems: 100,
              maxRequests: 512,
            });
            if (progress.state === "failed" || progress.state === "idle") {
              throw new Error(
                "MongoDB Insights projection provisioning failed.",
              );
            }
          }
          await source.ensureReady();
          await maintenance.ensureReady();
        },
      };
    },
  };
};

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
  const adapter = createDatabasePluginAdapter(
    "mongodb",
    config.transactions === true
      ? createTransactionalMongoImplementation(
          config.client,
          OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
        )
      : createMongoImplementation(
          config.client,
          OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
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
      createInsightsSchemaProvisioner: () =>
        createMongoInsightsSchemaProvisioner(
          config.client,
          OFFICIAL_INSIGHTS_DATABASE_NAMESPACE,
        ),
      provider: "mongodb" as const,
      createMigrator: () => createMongoMigrator(config.client),
    },
  );
};
