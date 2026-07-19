import type { MongoClient } from "mongodb";

import {
  HOT_UPDATER_SCHEMA_VERSION,
  HOT_UPDATER_SETTINGS_TABLE,
} from "../schema/types";
import {
  assertSupportedMigrationMode,
  assertSupportedSchemaVersion,
  getEmptyMigrationResult,
  isCurrentSchemaVersion,
} from "./fixedMigratorShared";
import {
  executeMongoMigration,
  MONGO_CHANNEL_ID_PIPELINE,
  MONGO_NORMALIZE_CHANNEL_FIELDS_PIPELINE,
} from "./mongoMigrationExecution";
import { createMongoMigrationOperations } from "./schema/mongodb";
import {
  hotUpdaterSchema,
  schemaIndexAppliesToProvider,
} from "./schema/registry";
import type {
  MigrateOptions,
  MigrationOperation,
  MigrationResult,
  Migrator,
} from "./types";

const isMongoNamespaceExistsError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const mongoError = error as { code?: unknown; codeName?: unknown };
  return mongoError.code === 48 || mongoError.codeName === "NamespaceExists";
};

const ignoreExistingCollection = (error: unknown): undefined => {
  if (isMongoNamespaceExistsError(error)) {
    return undefined;
  }
  throw error;
};

export const createMongoMigrator = (client: MongoClient): Migrator => {
  const settings = client
    .db()
    .collection<{ key: string; value: unknown }>(HOT_UPDATER_SETTINGS_TABLE);
  const getVersion = async (): Promise<string | undefined> => {
    const row = await settings.findOne({ key: "version" });
    return typeof row?.value === "string" ? row.value : undefined;
  };
  const makeResult = async (
    options: MigrateOptions = {},
  ): Promise<MigrationResult> => {
    assertSupportedMigrationMode(options);

    const currentVersion = await getVersion();
    if (isCurrentSchemaVersion(currentVersion)) {
      return getEmptyMigrationResult();
    }
    assertSupportedSchemaVersion(currentVersion);
    const settingsOperation =
      options.updateSettings === false
        ? undefined
        : ({
            type: "custom",
            key: "version",
            value: HOT_UPDATER_SCHEMA_VERSION,
          } satisfies MigrationOperation);
    return {
      operations: createMongoMigrationOperations(settingsOperation),
      execute: async () => {
        const db = client.db();
        const bundles = db.collection("bundles");
        const bundleChannels = db.collection<{
          readonly id: string;
          readonly name: string;
        }>("bundle_channels");
        await executeMongoMigration({
          updateSettings: options.updateSettings !== false,
          backend: {
            ensureCollections: async () => {
              for (const table of hotUpdaterSchema.tables) {
                if (table.internal) continue;
                await db
                  .createCollection(table.ormName)
                  .catch(ignoreExistingCollection);
              }
            },
            findChannelIds: async () => {
              const rows = await bundles
                .aggregate<{ readonly _id: string }>(MONGO_CHANNEL_ID_PIPELINE)
                .toArray();
              return rows.map(({ _id }) => _id);
            },
            upsertChannel: async (id) => {
              await bundleChannels.updateOne(
                { id },
                { $setOnInsert: { id, name: id } },
                { upsert: true },
              );
            },
            normalizeLegacyBundles: async () => {
              await bundles.updateMany(
                {
                  $or: [
                    { channel: { $type: "string", $ne: "" } },
                    { channel_id: { $type: "string", $ne: "" } },
                  ],
                },
                MONGO_NORMALIZE_CHANNEL_FIELDS_PIPELINE,
              );
              const storedChannels = await bundleChannels.find().toArray();
              for (const channel of storedChannels) {
                await bundles.updateMany(
                  { channel_id: channel.id },
                  { $set: { channel: channel.name } },
                );
              }
            },
            ensureIndexes: async () => {
              for (const table of hotUpdaterSchema.tables) {
                if (table.internal) continue;
                const collection = db.collection(table.ormName);
                const idIndexName = `${table.ormName}_id_idx`;
                const existingIdIndex = (
                  await collection.listIndexes().toArray()
                ).find(({ name }) => name === idIndexName);
                if (existingIdIndex && existingIdIndex.unique !== true) {
                  await collection.dropIndex(idIndexName);
                }
                await collection.createIndex(
                  { id: 1 },
                  { name: idIndexName, unique: true },
                );
                for (const index of (table.indexes ?? []).filter((item) =>
                  schemaIndexAppliesToProvider(item, "mongodb"),
                )) {
                  await collection.createIndex(
                    Object.fromEntries(
                      index.columns.map((column) => [column, 1]),
                    ),
                    {
                      name: index.name,
                      ...(index.unique ? { unique: true } : {}),
                    },
                  );
                }
              }
            },
            updateVersion: async () => {
              await settings.updateOne(
                { key: "version" },
                { $set: { value: HOT_UPDATER_SCHEMA_VERSION } },
                { upsert: true },
              );
            },
          },
        });
      },
    };
  };

  return {
    getVersion,
    getNameVariants: async () => undefined,
    next: async () =>
      isCurrentSchemaVersion(await getVersion())
        ? undefined
        : { version: HOT_UPDATER_SCHEMA_VERSION },
    previous: async () => undefined,
    up: makeResult,
    down: async () => {
      throw new Error("No previous schema to migrate to.");
    },
    migrateTo: async (version, options) => {
      if (version !== HOT_UPDATER_SCHEMA_VERSION) {
        throw new Error(`Invalid version ${version}`);
      }
      return makeResult(options);
    },
    migrateToLatest: makeResult,
  };
};
