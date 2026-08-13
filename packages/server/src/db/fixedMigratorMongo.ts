import { ObjectId, type MongoClient } from "mongodb";

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
import {
  applyMongoReleaseCatalogBackfill,
  legacyMongoBundlePolicyFields,
  prepareMongoReleaseCatalogBackfill,
  type PreparedMongoReleaseCatalogBackfill,
  validateMongoReleaseCatalogBackfill,
} from "./releaseCatalogBackfillMongo";
import { createMongoMigrationOperations } from "./schema/mongodb";
import {
  getSchemaVersionIndex,
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

const isMongoDuplicateKeyError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return (error as { code?: unknown }).code === 11000;
};

type MongoChannelRow = {
  readonly id: string;
  readonly name: string;
};

type MongoBundleChannelRow = {
  readonly channel: string;
  readonly channel_id?: string | null;
};

const legacyMongoBundleIndexNames = new Set([
  "bundles_channel_idx",
  "bundles_fingerprint_hash_idx",
  "bundles_rollout_idx",
  "bundles_target_app_version_idx",
]);

const mongoNullableString = { bsonType: ["string", "null"] } as const;

const mongoBundleValidator = {
  $and: [
    {
      $jsonSchema: {
        bsonType: "object",
        properties: {
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
          "metadata",
          "manifest_storage_uri",
          "manifest_file_hash",
          "asset_base_storage_uri",
        ],
      },
    },
    ...legacyMongoBundlePolicyFields.map((field) => ({
      [field]: { $exists: false },
    })),
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
      authority_id: { bsonType: "string" },
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
      "authority_id",
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

const isValidChannelIdentifier = (value: string): boolean => {
  const length = [...value].length;
  return length >= 1 && length <= 255;
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
    const currentVersion = coreVersion ?? legacyCoreVersion;
    const normalizeChannels =
      currentVersion !== undefined &&
      getSchemaVersionIndex(currentVersion) < getSchemaVersionIndex("0.38.0");
    const backfillReleaseCatalog = currentVersion !== undefined;
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
        ...createMongoMigrationOperations(settingsOperation, {
          backfillReleaseCatalog,
          normalizeChannels,
        }),
      ],
      execute: async () => {
        const db = client.db();
        let preparedBackfill: PreparedMongoReleaseCatalogBackfill | undefined;
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
            ...(backfillReleaseCatalog
              ? {
                  backfillData: async () => {
                    preparedBackfill = await prepareMongoReleaseCatalogBackfill(
                      {
                        authorityId: options.authorityId,
                        db,
                      },
                    );
                    const bundles =
                      db.collection<MongoBundleChannelRow>("bundles");
                    const channels = db.collection<MongoChannelRow>("channels");
                    const channelNames = new Set(
                      preparedBackfill.backfill?.releases.map(
                        ({ channelName }) => channelName,
                      ) ?? [],
                    );
                    for (const name of channelNames) {
                      if (
                        typeof name !== "string" ||
                        !isValidChannelIdentifier(name)
                      ) {
                        throw new Error(
                          "MongoDB legacy bundle channel must contain 1 to 255 Unicode code points for 0.38.0 migration.",
                        );
                      }
                      const existing = await channels
                        .find({ name })
                        .limit(2)
                        .toArray();
                      if (existing.length > 1) {
                        throw new Error(
                          `Duplicate MongoDB Channel name before 0.38.0 constraints: ${name}`,
                        );
                      }
                      let canonical: MongoChannelRow | undefined = existing[0];
                      if (
                        canonical &&
                        (typeof canonical.id !== "string" ||
                          canonical.name !== name)
                      ) {
                        throw new Error(
                          `Invalid MongoDB Channel row before 0.38.0 backfill: ${name}`,
                        );
                      }
                      if (!canonical && normalizeChannels) {
                        const candidate = {
                          id: new ObjectId().toHexString(),
                          name,
                        } satisfies MongoChannelRow;
                        try {
                          await channels.insertOne(candidate);
                          canonical = candidate;
                        } catch (error) {
                          if (!isMongoDuplicateKeyError(error)) throw error;
                          const raced = await channels.findOne({ name });
                          if (!raced) throw error;
                          canonical = raced;
                        }
                      }
                      if (!canonical) {
                        throw new Error(
                          `MongoDB Channel is missing before Release backfill: ${name}`,
                        );
                      }
                    }
                    const storedChannels = await channels.find({}).toArray();
                    const channelsById = new Map<string, MongoChannelRow>();
                    const channelsByName = new Map<string, MongoChannelRow>();
                    const storedChannelNames = new Set<string>();
                    for (const channel of storedChannels) {
                      if (
                        typeof channel.id !== "string" ||
                        typeof channel.name !== "string" ||
                        !isValidChannelIdentifier(channel.id) ||
                        !isValidChannelIdentifier(channel.name) ||
                        channelsById.has(channel.id) ||
                        storedChannelNames.has(channel.name)
                      ) {
                        throw new Error(
                          "Invalid or duplicate MongoDB Channel row before 0.38.0 constraints.",
                        );
                      }
                      channelsById.set(channel.id, channel);
                      channelsByName.set(channel.name, channel);
                      storedChannelNames.add(channel.name);
                    }
                    const legacyBundles = await bundles.find({}).toArray();
                    for (const bundle of legacyBundles) {
                      if (
                        typeof bundle.channel_id === "string" &&
                        channelsById.get(bundle.channel_id)?.name !==
                          bundle.channel
                      ) {
                        throw new Error(
                          "MongoDB Channel backfill is incomplete; bundle channel and channel_id do not match.",
                        );
                      }
                    }
                    await applyMongoReleaseCatalogBackfill({
                      db,
                      prepared: preparedBackfill,
                      resolveChannelId: (channelName) => {
                        const channel = channelsByName.get(channelName);
                        if (!channel) {
                          throw new Error(
                            `MongoDB Channel is missing before Release backfill: ${channelName}`,
                          );
                        }
                        return channel.id;
                      },
                    });
                  },
                  validateData: async () => {
                    await validateMongoReleaseCatalogBackfill({
                      authorityId: options.authorityId,
                      db,
                    });
                  },
                }
              : {}),
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
                if (table.ormName === "bundles") {
                  for (const index of existingIndexes) {
                    if (
                      typeof index.name === "string" &&
                      legacyMongoBundleIndexNames.has(index.name)
                    ) {
                      await collection.dropIndex(index.name);
                    }
                  }
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
