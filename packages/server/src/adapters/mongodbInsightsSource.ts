import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  Long,
  ObjectId,
  type ClientSession,
  type Collection,
  type MongoClient,
} from "mongodb";

import {
  assertMongoInsightsEventRow,
  isMongoInsightsEventId,
} from "./mongodbInsights";
import {
  MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
  MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
  MONGO_INSIGHTS_SOURCE_SHARDS,
  MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
  MONGO_INSIGHTS_SOURCE_STATE_ID,
  type MongoBundleEventDocument,
  type MongoInsightsSourceClock,
  type MongoInsightsSourceEvent,
  type MongoInsightsSourceState,
} from "./mongodbInsightsSourceSchema";

export * from "./mongodbInsightsSourceSchema";

export type MongoInsightsSourceCollections = {
  readonly bundleEvents: Collection<MongoBundleEventDocument>;
  readonly sourceState: Collection<MongoInsightsSourceState>;
  readonly sourceClocks: Collection<MongoInsightsSourceClock>;
  readonly sourceEvents: Collection<MongoInsightsSourceEvent>;
};

export const createMongoInsightsSourceCollections = (
  client: MongoClient,
): MongoInsightsSourceCollections => {
  const database = client.db();
  return {
    bundleEvents:
      database.collection<MongoBundleEventDocument>("bundle_events"),
    sourceState: database.collection<MongoInsightsSourceState>(
      MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
    ),
    sourceClocks: database.collection<MongoInsightsSourceClock>(
      MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
    ),
    sourceEvents: database.collection<MongoInsightsSourceEvent>(
      MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION,
    ),
  };
};

export const mongoInsightsSourceShard = (eventId: string): number => {
  if (!isMongoInsightsEventId(eventId))
    throw new DatabasePluginInputError("invalid-data");
  return (
    createHash("sha256").update(eventId, "utf8").digest()[0]! %
    MONGO_INSIGHTS_SOURCE_SHARDS
  );
};

const validState = (
  value: MongoInsightsSourceState | null,
): value is MongoInsightsSourceState =>
  value !== null &&
  value.version === 1 &&
  (value.phase === "auditing" || value.phase === "ready") &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value.sourceId,
  );

export const appendMongoInsightsSourceEvent = async (
  collections: MongoInsightsSourceCollections,
  row: BundleEventRow,
  session: ClientSession | undefined,
): Promise<BundleEventRow> => {
  assertMongoInsightsEventRow(row);
  if (session === undefined) throw new InsightsQueryNotReadyError();
  const state = await collections.sourceState.findOne(
    { _id: MONGO_INSIGHTS_SOURCE_STATE_ID },
    { session },
  );
  if (!validState(state)) throw new InsightsQueryNotReadyError();

  const shard = mongoInsightsSourceShard(row.id);
  const rawId = new ObjectId();
  await collections.bundleEvents.insertOne({ ...row, _id: rawId }, { session });
  const clock = await collections.sourceClocks.findOneAndUpdate(
    {
      _id: shard,
      sourceId: state.sourceId,
      value: { $lt: Long.MAX_VALUE },
    },
    { $inc: { value: Long.ONE } },
    { session, returnDocument: "after", promoteLongs: false },
  );
  if (!clock || !Long.isLong(clock.value) || clock.value.lessThanOrEqual(0))
    throw new InsightsQueryNotReadyError();
  await collections.sourceEvents.insertOne(
    {
      _id: row.id,
      sourceId: state.sourceId,
      shard,
      sequence: clock.value,
      rawId,
    },
    { session },
  );
  return row;
};
