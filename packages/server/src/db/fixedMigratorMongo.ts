import type { MongoClient } from "mongodb";

import {
  HOT_UPDATER_CORE_SCHEMA_KEY,
  HOT_UPDATER_SCHEMA_VERSION,
  HOT_UPDATER_SETTINGS_TABLE,
} from "../schema/types";
import {
  assertCurrentOrEmptySchemaVersion,
  assertSupportedMigrationMode,
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

const mongoNullableString = { bsonType: ["string", "null"] } as const;
const mongoByteSize = {
  bsonType: ["double", "int", "long"],
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: 0,
} as const;

const mongoBundleValidator = {
  $and: [
    {
      $jsonSchema: {
        bsonType: "object",
        properties: {
          archive_byte_size: mongoByteSize,
          asset_base_storage_uri: mongoNullableString,
          file_hash: { bsonType: "string" },
          git_commit_hash: mongoNullableString,
          id: { bsonType: "string" },
          manifest_file_hash: mongoNullableString,
          manifest_storage_uri: mongoNullableString,
          metadata: { bsonType: "object" },
          platform: { enum: ["ios", "android"] },
          storage_uri: { bsonType: "string" },
        },
        required: [
          "id",
          "platform",
          "file_hash",
          "git_commit_hash",
          "storage_uri",
          "archive_byte_size",
          "metadata",
          "manifest_storage_uri",
          "manifest_file_hash",
          "asset_base_storage_uri",
        ],
      },
    },
    {
      $expr: {
        $eq: [{ $trunc: "$archive_byte_size" }, "$archive_byte_size"],
      },
    },
  ],
} as const;

const mongoPatchValidator = {
  $and: [
    {
      $jsonSchema: {
        bsonType: "object",
        properties: {
          base_bundle_id: { bsonType: "string" },
          base_file_hash: { bsonType: "string" },
          bundle_id: { bsonType: "string" },
          id: { bsonType: "string" },
          order_index: mongoByteSize,
          byte_size: mongoByteSize,
          patch_file_hash: { bsonType: "string" },
          patch_storage_uri: { bsonType: "string" },
        },
        required: [
          "id",
          "bundle_id",
          "base_bundle_id",
          "base_file_hash",
          "patch_file_hash",
          "patch_storage_uri",
          "byte_size",
          "order_index",
        ],
      },
    },
    {
      $expr: {
        $and: [
          { $eq: [{ $trunc: "$order_index" }, "$order_index"] },
          { $eq: [{ $trunc: "$byte_size" }, "$byte_size"] },
        ],
      },
    },
  ],
} as const;

const mongoReleaseValidator = {
  $jsonSchema: {
    bsonType: "object",
    properties: {
      bundle_id: mongoNullableString,
      channel_id: { bsonType: "string" },
      created_at_ms: { bsonType: ["double", "int", "long"] },
      enabled: { bsonType: "bool" },
      fingerprint_hash: mongoNullableString,
      id: { bsonType: "string" },
      kind: { enum: ["BUNDLE", "EMBEDDED"] },
      message: mongoNullableString,
      operation: { enum: ["DEPLOY", "PROMOTE", "ROLLBACK"] },
      platform: { enum: ["ios", "android"] },
      revision: { bsonType: ["int", "long"] },
      rollout_cohort_count: { bsonType: ["int", "long"] },
      scope_key: { bsonType: "string" },
      should_force_update: { bsonType: "bool" },
      source_release_id: mongoNullableString,
      strategy: { enum: ["APP_VERSION", "FINGERPRINT"] },
      target_app_version: mongoNullableString,
      target_cohorts: { bsonType: "array", items: { bsonType: "string" } },
      updated_at_ms: { bsonType: ["double", "int", "long"] },
    },
    required: [
      "id",
      "revision",
      "scope_key",
      "channel_id",
      "platform",
      "kind",
      "bundle_id",
      "strategy",
      "target_app_version",
      "fingerprint_hash",
      "enabled",
      "should_force_update",
      "message",
      "rollout_cohort_count",
      "target_cohorts",
      "operation",
      "source_release_id",
      "created_at_ms",
      "updated_at_ms",
    ],
  },
} as const;

const mongoReleaseCatalogValidator = {
  $jsonSchema: {
    bsonType: "object",
    properties: {
      catalog_id: { bsonType: "string" },
      byte_size: { bsonType: ["int", "long"] },
      catalog_hash: { bsonType: "string" },
      channel_id: { bsonType: "string" },
      channel_key: { bsonType: "string" },
      fingerprint_hash: mongoNullableString,
      generation: { bsonType: ["double", "int", "long"] },
      is_tombstone: { bsonType: "bool" },
      payload: { bsonType: "string" },
      platform: { enum: ["ios", "android"] },
      scope_key: { bsonType: "string" },
      strategy: { enum: ["APP_VERSION", "FINGERPRINT"] },
      updated_at_ms: { bsonType: ["double", "int", "long"] },
    },
    required: [
      "scope_key",
      "catalog_id",
      "strategy",
      "channel_id",
      "channel_key",
      "platform",
      "fingerprint_hash",
      "generation",
      "payload",
      "catalog_hash",
      "byte_size",
      "is_tombstone",
      "updated_at_ms",
    ],
  },
} as const;

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
    assertCurrentOrEmptySchemaVersion(coreVersion ?? legacyCoreVersion);
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
                const primaryKey = table.columns.find(
                  (column) => column.primaryKey,
                );
                if (!primaryKey) {
                  throw new Error(
                    `MongoDB table ${table.ormName} does not define a primary key.`,
                  );
                }
                const idIndexName = `${table.ormName}_${primaryKey.ormName}_idx`;
                const existingIndexes = await collection
                  .listIndexes()
                  .toArray();
                const existingIdIndex = existingIndexes.find(
                  ({ name }) => name === idIndexName,
                );
                if (existingIdIndex && existingIdIndex.unique !== true) {
                  await collection.dropIndex(idIndexName);
                }
                await collection.createIndex(
                  { [primaryKey.ormName]: 1 },
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
            enforceSchema: async () => {
              for (const [collection, validator] of [
                ["bundles", mongoBundleValidator],
                ["bundle_patches", mongoPatchValidator],
                ["releases", mongoReleaseValidator],
                ["release_catalogs", mongoReleaseCatalogValidator],
              ] as const) {
                await db.command({
                  collMod: collection,
                  validationAction: "error",
                  validationLevel: "strict",
                  validator,
                });
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
