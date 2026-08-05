import type { MongoClient } from "mongodb";

import {
  HOT_UPDATER_CORE_SCHEMA_KEY,
  HOT_UPDATER_SCHEMA_VERSION,
  HOT_UPDATER_SETTINGS_TABLE,
} from "../schema/types";
import {
  assertSupportedMigrationMode,
  assertSupportedSchemaVersion,
  getEmptyMigrationResult,
  inferLegacyCoreSchemaVersion,
  isCurrentSchemaVersion,
} from "./fixedMigratorShared";
import { executeMongoMigration } from "./mongoMigrationExecution";
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

const isMongoNamespaceNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const mongoError = error as { code?: unknown; codeName?: unknown };
  return mongoError.code === 26 || mongoError.codeName === "NamespaceNotFound";
};

const ignoreExistingCollection = (error: unknown): undefined => {
  if (isMongoNamespaceExistsError(error)) {
    return undefined;
  }
  throw error;
};

const createSettingsKeyIndexOperation = (): MigrationOperation => ({
  description: `Ensure unique MongoDB index: ${HOT_UPDATER_SETTINGS_TABLE}(key)`,
  type: "custom",
});

export const createMongoMigrator = (client: MongoClient): Migrator => {
  const settings = client
    .db()
    .collection<{ key: string; value: unknown }>(HOT_UPDATER_SETTINGS_TABLE);
  const getSetting = async (key: string): Promise<string | undefined> => {
    const rows = await settings.find({ key }).limit(2).toArray();
    const [row, duplicate] = rows;
    if (!row) return undefined;
    if (duplicate) {
      throw new Error(`Duplicate Hot Updater schema setting: ${key}`);
    }
    if (typeof row.value !== "string") {
      throw new Error(`Invalid Hot Updater schema setting: ${key}`);
    }
    return row.value;
  };
  const getCoreVersion = (): Promise<string | undefined> =>
    getSetting(HOT_UPDATER_CORE_SCHEMA_KEY);
  const getSchemaVersions = async (): Promise<{
    readonly coreVersion: string | undefined;
    readonly legacyCoreVersion: string | undefined;
  }> => {
    const coreVersion = await getCoreVersion();
    const legacyCoreVersion = inferLegacyCoreSchemaVersion(
      await getSetting("version"),
    );
    if (coreVersion !== undefined) {
      assertSupportedSchemaVersion(coreVersion);
      assertSupportedSchemaVersion(legacyCoreVersion);
    }
    return { coreVersion, legacyCoreVersion };
  };
  const getVersion = async (): Promise<string | undefined> => {
    const { coreVersion, legacyCoreVersion } = await getSchemaVersions();
    return coreVersion ?? legacyCoreVersion;
  };
  const getSettingsKeyIndexState = async (): Promise<
    "missing" | "non-unique" | "unique"
  > => {
    const indexes = await settings
      .listIndexes()
      .toArray()
      .catch((error: unknown) => {
        if (isMongoNamespaceNotFoundError(error)) return [];
        throw error;
      });
    const index = indexes.find(({ key }) => {
      const fields = Object.entries(key);
      return (
        fields.length === 1 && fields[0]?.[0] === "key" && fields[0][1] === 1
      );
    });
    if (!index) return "missing";
    return index.unique === true &&
      index.sparse !== true &&
      index.partialFilterExpression === undefined
      ? "unique"
      : "non-unique";
  };
  const rejectNonUniqueSettingsKeyIndex = (): never => {
    throw new Error(
      "Hot Updater settings key index must enforce uniqueness for every key.",
    );
  };
  const ensureSettingsKeyIndex = async (): Promise<void> => {
    const state = await getSettingsKeyIndexState();
    if (state === "unique") return;
    if (state === "non-unique") rejectNonUniqueSettingsKeyIndex();
    await settings.createIndex({ key: 1 }, { unique: true });
  };
  const makeResult = async (
    options: MigrateOptions = {},
  ): Promise<MigrationResult> => {
    assertSupportedMigrationMode(options);

    const { coreVersion, legacyCoreVersion } = await getSchemaVersions();
    const settingsKeyIndexState = await getSettingsKeyIndexState();
    if (settingsKeyIndexState === "non-unique") {
      rejectNonUniqueSettingsKeyIndex();
    }
    if (isCurrentSchemaVersion(coreVersion)) {
      if (settingsKeyIndexState === "unique") {
        return getEmptyMigrationResult();
      }
      return {
        ...getEmptyMigrationResult(),
        execute: ensureSettingsKeyIndex,
        operations: [createSettingsKeyIndexOperation()],
      };
    }
    assertSupportedSchemaVersion(coreVersion ?? legacyCoreVersion);
    const settingsOperation =
      options.updateSettings === false
        ? undefined
        : ({
            type: "custom",
            key: HOT_UPDATER_CORE_SCHEMA_KEY,
            value: HOT_UPDATER_SCHEMA_VERSION,
          } satisfies MigrationOperation);
    return {
      operations: [
        createSettingsKeyIndexOperation(),
        ...createMongoMigrationOperations(settingsOperation),
      ],
      execute: async () => {
        const db = client.db();
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
            ensureIndexes: async () => {
              await ensureSettingsKeyIndex();
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
                { key: HOT_UPDATER_CORE_SCHEMA_KEY },
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
    next: async () => {
      const { coreVersion } = await getSchemaVersions();
      return isCurrentSchemaVersion(coreVersion)
        ? undefined
        : { version: HOT_UPDATER_SCHEMA_VERSION };
    },
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
