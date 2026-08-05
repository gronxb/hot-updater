import {
  ANALYTICS_SCHEMA_KEY,
  ANALYTICS_SCHEMA_FINGERPRINT_V2,
  ANALYTICS_SCHEMA_VERSION,
  AnalyticsSchemaCompatibilityError,
  AnalyticsSchemaNotReadyError,
  migrateAnalyticsSchema,
  type AnalyticsMigrationResult,
  type AnalyticsSchemaInspection,
  type AnalyticsSchemaMigrationStore,
} from "../provider/migration";
import {
  MONGO_ANALYTICS_SCHEMA_V2_VALIDATOR,
  mongoAnalyticsIndexes,
} from "./mongodbArtifacts";
import { inspectMongoAnalyticsFingerprint } from "./mongodbSchema";
import type {
  MongoAnalyticsConfig,
  MongoAnalyticsDocument,
} from "./mongodbTypes";
import { mongoOperationOptions } from "./mongodbTypes";

const SETTINGS_COLLECTION = "private_hot_updater_settings";

export class MongoAnalyticsSchemaSettingError extends Error {
  readonly name = "MongoAnalyticsSchemaSettingError";

  constructor(
    readonly key: string,
    readonly value: unknown,
  ) {
    super(`Invalid MongoDB Analytics schema setting: ${key}`);
  }
}

const property = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const readSetting = async (
  config: MongoAnalyticsConfig,
  key: string,
): Promise<string | null> => {
  const row = await config.database
    .collection(SETTINGS_COLLECTION)
    .findOne({ key }, mongoOperationOptions(config.session));
  if (row === null) return null;
  const value = property(row, "value");
  if (typeof value !== "string") {
    throw new MongoAnalyticsSchemaSettingError(key, value);
  }
  return value;
};

const inspect = async (
  config: MongoAnalyticsConfig,
): Promise<AnalyticsSchemaInspection> => {
  const componentVersion = await readSetting(config, ANALYTICS_SCHEMA_KEY);
  const legacyVersion = await readSetting(config, "version");
  const fingerprint = await inspectMongoAnalyticsFingerprint(
    config,
    componentVersion,
    legacyVersion,
  );
  return { componentVersion, fingerprint, legacyVersion };
};

const installV2Validator = (config: MongoAnalyticsConfig): Promise<unknown> =>
  config.database.command(
    {
      collMod: "bundle_events",
      validationAction: "error",
      validationLevel: "strict",
      validator: MONGO_ANALYTICS_SCHEMA_V2_VALIDATOR,
    },
    mongoOperationOptions(config.session),
  );

const validateV2 = async (config: MongoAnalyticsConfig): Promise<void> => {
  const inspection = await inspect(config);
  if (inspection.fingerprint !== ANALYTICS_SCHEMA_FINGERPRINT_V2) {
    throw new AnalyticsSchemaCompatibilityError(inspection);
  }
};

const completeV2Artifacts = async (
  config: MongoAnalyticsConfig,
): Promise<void> => {
  const collections = await config.database
    .listCollections(
      { name: "bundle_events" },
      mongoOperationOptions(config.session),
    )
    .toArray();
  if (collections.length === 0) {
    await config.database.createCollection("bundle_events", {
      validationAction: "error",
      validationLevel: "strict",
      validator: MONGO_ANALYTICS_SCHEMA_V2_VALIDATOR,
      ...mongoOperationOptions(config.session),
    });
  }
  const collection = config.database.collection("bundle_events");
  const existingIndexes = await collection
    .listIndexes(mongoOperationOptions(config.session))
    .toArray();
  const existingNames = new Set(
    existingIndexes.map((index) => String(property(index, "name"))),
  );
  for (const index of mongoAnalyticsIndexes) {
    if (existingNames.has(index.name)) continue;
    await collection.createIndex(index.key, {
      name: index.name,
      ...(index.unique === true ? { unique: true } : {}),
      ...mongoOperationOptions(config.session),
    });
  }
};

export const createMongoAnalyticsMigrationStore = (
  config: MongoAnalyticsConfig,
): AnalyticsSchemaMigrationStore => ({
  inspect: () => inspect(config),
  createV2: () => completeV2Artifacts(config),
  migrateV1ToV2: async () => {
    await installV2Validator(config);
  },
  validateV2: () => validateV2(config),
  writeComponentVersion: async (version) => {
    const update: MongoAnalyticsDocument = { $set: { value: version } };
    await config.database
      .collection(SETTINGS_COLLECTION)
      .updateOne({ key: ANALYTICS_SCHEMA_KEY }, update, {
        upsert: true,
        ...mongoOperationOptions(config.session),
      });
  },
});

export const migrateMongoAnalyticsSchema = (
  config: MongoAnalyticsConfig,
): Promise<AnalyticsMigrationResult> =>
  migrateAnalyticsSchema(createMongoAnalyticsMigrationStore(config));

export const assertMongoAnalyticsSchemaReady = async (
  config: MongoAnalyticsConfig,
): Promise<void> => {
  const inspection = await inspect(config);
  if (
    inspection.componentVersion !== ANALYTICS_SCHEMA_VERSION ||
    inspection.fingerprint !== ANALYTICS_SCHEMA_FINGERPRINT_V2
  ) {
    throw new AnalyticsSchemaNotReadyError(inspection);
  }
};

export const assertMongoAnalyticsSchemaMarkerReady = async (
  config: MongoAnalyticsConfig,
): Promise<void> => {
  const componentVersion = await readSetting(config, ANALYTICS_SCHEMA_KEY);
  if (componentVersion !== ANALYTICS_SCHEMA_VERSION) {
    throw new AnalyticsSchemaNotReadyError({
      componentVersion,
      fingerprint: null,
      legacyVersion: null,
    });
  }
};
