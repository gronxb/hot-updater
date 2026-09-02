import type { BundleEventRow } from "@hot-updater/plugin-core";
import type { Document, Long } from "mongodb";

export const MONGO_INSIGHTS_SOURCE_SHARDS = 16;
export const MONGO_INSIGHTS_DATABASE_NAMESPACE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isMongoInsightsDatabaseNamespace = (
  value: unknown,
): value is string =>
  typeof value === "string" &&
  MONGO_INSIGHTS_DATABASE_NAMESPACE_PATTERN.test(value);
export const MONGO_INSIGHTS_SOURCE_STATE_ID = "source";
export const MONGO_INSIGHTS_SOURCE_STATE_COLLECTION =
  "private_hot_updater_insights_source";
export const MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION =
  "private_hot_updater_insights_source_clocks";
export const MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION =
  "private_hot_updater_insights_source_events";

export type MongoBundleEventDocument = BundleEventRow & Document;
export type MongoInsightsSourceState = {
  readonly _id: typeof MONGO_INSIGHTS_SOURCE_STATE_ID;
  readonly version: 1;
  readonly revision: number;
  readonly phase: "auditing" | "ready";
  readonly sourceId: string;
  readonly eventCollectionUuid: string;
  readonly stateCollectionUuid: string;
  readonly clockCollectionUuid: string;
  readonly ledgerCollectionUuid: string;
  readonly upperId: string | null;
  readonly afterId: string | null;
  readonly processed: number;
};
export type MongoInsightsSourceClock = {
  readonly _id: number;
  readonly sourceId: string;
  readonly value: Long;
};
export type MongoInsightsSourceEvent = {
  readonly _id: string;
  readonly sourceId: string;
  readonly shard: number;
  readonly sequence: Long;
  readonly rawId: string;
};
