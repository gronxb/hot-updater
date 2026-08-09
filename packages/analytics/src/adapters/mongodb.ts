import type {
  AnalyticsPersistence,
  AnalyticsScanInput,
  BundleEventPersistenceRow,
} from "../provider/persistence";
import { parseBundleEventPersistenceRow } from "../provider/rowParser";
import {
  assertMongoAnalyticsSchemaMarkerReady,
  assertMongoAnalyticsSchemaReady,
  createMongoAnalyticsMigrationStore,
  migrateMongoAnalyticsSchema,
  MongoAnalyticsSchemaSettingError,
} from "./mongodbMigration";
import type {
  MongoAnalyticsConfig,
  MongoAnalyticsDocument,
} from "./mongodbTypes";
import { mongoOperationOptions } from "./mongodbTypes";

export {
  assertMongoAnalyticsSchemaReady,
  createMongoAnalyticsMigrationStore,
  migrateMongoAnalyticsSchema,
  MongoAnalyticsSchemaSettingError,
} from "./mongodbMigration";
export { MONGO_ANALYTICS_SCHEMA_V2_VALIDATOR } from "./mongodbArtifacts";
export {
  type MongoAnalyticsCollection,
  type MongoAnalyticsConfig,
  type MongoAnalyticsCursor,
  type MongoAnalyticsDatabase,
  type MongoAnalyticsDocument,
  type MongoAnalyticsListCursor,
} from "./mongodbTypes";

function getScanFilter(input: AnalyticsScanInput): MongoAnalyticsDocument {
  const cutoff = { received_at_ms: { $lt: input.beforeReceivedAtMs } };
  if (input.after === undefined) return cutoff;
  return {
    $and: [
      cutoff,
      {
        $or: [
          { received_at_ms: { $gt: input.after.receivedAtMs } },
          {
            received_at_ms: input.after.receivedAtMs,
            id: { $gt: input.after.id },
          },
        ],
      },
    ],
  };
}

export function createMongoAnalyticsPersistence(
  config: MongoAnalyticsConfig,
): AnalyticsPersistence {
  const collection = config.database.collection("bundle_events");
  let readiness: Promise<void> | undefined;

  async function ensureReady(): Promise<void> {
    try {
      await assertMongoAnalyticsSchemaMarkerReady(config);
    } catch (error) {
      readiness = undefined;
      throw error;
    }
    readiness ??= assertMongoAnalyticsSchemaReady(config).catch(
      (error: unknown) => {
        readiness = undefined;
        throw error;
      },
    );
    return readiness;
  }

  return {
    async append(row) {
      await ensureReady();
      await collection.insertOne(
        { ...row },
        mongoOperationOptions(config.session),
      );
    },
    async scan(input): Promise<readonly BundleEventPersistenceRow[]> {
      await ensureReady();
      const documents = await collection
        .find(getScanFilter(input), {
          projection: { _id: 0 },
          ...mongoOperationOptions(config.session),
        })
        .sort({ received_at_ms: 1, id: 1 })
        .limit(input.limit)
        .toArray();
      return documents.map(parseBundleEventPersistenceRow);
    },
  };
}
