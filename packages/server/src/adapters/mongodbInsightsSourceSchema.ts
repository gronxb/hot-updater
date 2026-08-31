import type { BundleEventRow } from "@hot-updater/plugin-core";
import type { Long, ObjectId } from "mongodb";

export const MONGO_INSIGHTS_SOURCE_SHARDS = 16;
export const MONGO_INSIGHTS_SOURCE_PAGE_MAX_BYTES = 16 * 1024 * 1024;
export const MONGO_INSIGHTS_SOURCE_STATE_ID = "source";
export const MONGO_INSIGHTS_SOURCE_STATE_COLLECTION =
  "private_hot_updater_insights_source";
export const MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION =
  "private_hot_updater_insights_source_clocks";
export const MONGO_INSIGHTS_SOURCE_EVENT_COLLECTION =
  "private_hot_updater_insights_source_events";

export type MongoBundleEventDocument = BundleEventRow & {
  readonly _id: ObjectId;
};
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
  readonly rawId: ObjectId;
};
