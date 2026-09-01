import type {
  BundleEventRow,
  InsightsReportPublication,
  InsightsReportQuery,
} from "@hot-updater/plugin-core";
import type { Collection, Document, Long, MongoClient } from "mongodb";

import { MONGO_INSIGHTS_SOURCE_SHARDS } from "./mongodbInsightsSourceSchema";

export const MONGO_INSIGHTS_STORAGE_VERSION = "mongodb-insights-2";
export const MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION =
  "private_hot_updater_insights_projection";
export const MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION =
  "private_hot_updater_insights_projection_events";
export const MONGO_INSIGHTS_INSTALLATION_COLLECTION =
  "private_hot_updater_insights_installations";
export const MONGO_INSIGHTS_ALIAS_COLLECTION =
  "private_hot_updater_insights_aliases";
export const MONGO_INSIGHTS_LIVE_SNAPSHOT_COLLECTION =
  "private_hot_updater_insights_live_snapshots";
export const MONGO_INSIGHTS_SEARCH_HEAD_COLLECTION =
  "private_hot_updater_insights_search_heads";
export const MONGO_INSIGHTS_SEARCH_JOB_COLLECTION =
  "private_hot_updater_insights_search_jobs";
export const MONGO_INSIGHTS_SEARCH_ROW_COLLECTION =
  "private_hot_updater_insights_search_rows";
export const MONGO_INSIGHTS_REPORT_HEAD_COLLECTION =
  "private_hot_updater_insights_report_heads";
export const MONGO_INSIGHTS_REPORT_JOB_COLLECTION =
  "private_hot_updater_insights_report_jobs";
export const MONGO_INSIGHTS_REPORT_MEMBER_COLLECTION =
  "private_hot_updater_insights_report_members";
export const MONGO_INSIGHTS_REPORT_LATEST_COLLECTION =
  "private_hot_updater_insights_report_latest";
export const MONGO_INSIGHTS_REPORT_BUCKET_COLLECTION =
  "private_hot_updater_insights_report_buckets";
export const MONGO_INSIGHTS_REPORT_COUNT_COLLECTION =
  "private_hot_updater_insights_report_counts";
export const MONGO_INSIGHTS_REPORT_ORDER_COLLECTION =
  "private_hot_updater_insights_report_order";
export const MONGO_INSIGHTS_PROJECTION_STATE_ID = "projection";
export const MONGO_INSIGHTS_MODEL_COLLECTIONS = [
  MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
  MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION,
  MONGO_INSIGHTS_INSTALLATION_COLLECTION,
  MONGO_INSIGHTS_ALIAS_COLLECTION,
  MONGO_INSIGHTS_LIVE_SNAPSHOT_COLLECTION,
  MONGO_INSIGHTS_SEARCH_HEAD_COLLECTION,
  MONGO_INSIGHTS_SEARCH_JOB_COLLECTION,
  MONGO_INSIGHTS_SEARCH_ROW_COLLECTION,
  MONGO_INSIGHTS_REPORT_HEAD_COLLECTION,
  MONGO_INSIGHTS_REPORT_JOB_COLLECTION,
  MONGO_INSIGHTS_REPORT_MEMBER_COLLECTION,
  MONGO_INSIGHTS_REPORT_LATEST_COLLECTION,
  MONGO_INSIGHTS_REPORT_BUCKET_COLLECTION,
  MONGO_INSIGHTS_REPORT_COUNT_COLLECTION,
  MONGO_INSIGHTS_REPORT_ORDER_COLLECTION,
] as const;
export type MongoInsightsModelCollectionName =
  (typeof MONGO_INSIGHTS_MODEL_COLLECTIONS)[number];

export type MongoInsightsProjectionState = {
  readonly _id: typeof MONGO_INSIGHTS_PROJECTION_STATE_ID;
  readonly version: 1;
  readonly revision: number;
  readonly phase: "building" | "ready" | "failed";
  readonly sourceId: string;
  readonly targetGeneration: string;
  readonly shard: number;
  readonly sourceCounters: readonly Long[];
  readonly nextProjectionSequence: Long;
  readonly poisonEventId: string | null;
  readonly collectionUuids: Readonly<
    Record<MongoInsightsModelCollectionName, string>
  >;
};

export type MongoInsightsProjectionEvent = {
  readonly _id: string;
  readonly sourceId: string;
  readonly sourceShard: number;
  readonly sourceSequence: Long;
  readonly projectionSequence: Long;
  readonly latestVersion: boolean;
  readonly installKey: string;
  readonly installId: string;
  readonly event: BundleEventRow;
};

export type MongoInsightsInstallation = {
  readonly _id: string;
  readonly installId: string;
  readonly firstProjectionSequence: Long;
};

export type MongoInsightsAlias = {
  readonly _id: string;
  readonly kind: "install" | "user" | "username";
  readonly value: string;
  readonly normalized: string;
  readonly installKey: string;
  readonly installId: string;
  readonly firstProjectionSequence: Long;
};

export type MongoInsightsLiveSnapshot = {
  readonly _id: string;
  readonly kind: "all" | "installationId";
  readonly installId: string | null;
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly projectionUpper: Long;
  readonly observedAtMs: number;
  readonly atClusterTimeSeconds: number;
  readonly atClusterTimeIncrement: number;
};

export type MongoInsightsSearchDescriptor =
  | { readonly kind: "contains"; readonly normalized: string }
  | { readonly kind: "userId"; readonly userId: string };

export type MongoInsightsSearchHead = {
  readonly _id: string;
  readonly descriptor: MongoInsightsSearchDescriptor;
  readonly activeJobId: string | null;
  readonly publicationJobId: string | null;
};

export type MongoInsightsSearchJob = {
  readonly _id: string;
  readonly queryHash: string;
  readonly descriptor: MongoInsightsSearchDescriptor;
  readonly state: "queued" | "preparing" | "ready" | "failed";
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly projectionUpper: Long;
  readonly asOfMs: number;
  readonly completedAtMs: number | null;
  readonly afterAliasSequence: Long | null;
  readonly afterAliasId: string | null;
  readonly total: number | null;
  readonly leaseOwner: string | null;
  readonly leaseEpoch: number;
  readonly leaseExpiresAt: Date | null;
};

export type MongoInsightsSearchRow = {
  readonly _id: string;
  readonly jobId: string;
  readonly installKey: string;
  readonly installId: string;
  readonly event: BundleEventRow;
};

export type MongoInsightsReportHead = {
  readonly _id: string;
  readonly query: InsightsReportQuery;
  readonly activeJobId: string | null;
  readonly publicationJobId: string | null;
};

export type MongoInsightsReportJob = {
  readonly _id: string;
  readonly queryHash: string;
  readonly query: InsightsReportQuery;
  readonly state: "queued" | "preparing" | "ready" | "failed";
  readonly phase: "source" | "installations" | "buckets" | "order" | "publish";
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly projectionUpper: Long;
  readonly asOfMs: number;
  readonly completedAtMs: number | null;
  readonly afterProjectionSequence: Long;
  readonly afterInstallKey: string | null;
  readonly afterBucketId: string | null;
  readonly orderSection: number;
  readonly orderAfterValue: number | null;
  readonly orderAfterKey: string | null;
  readonly orderAfterId: string | null;
  readonly nextOrdinal: Long;
  readonly orderTotals: readonly number[];
  readonly publishIndex: number;
  readonly publishBundleSummaries: readonly {
    readonly bundleId: string;
    readonly installed: number;
    readonly recovered: number;
  }[];
  readonly publication: InsightsReportPublication | null;
  readonly leaseOwner: string | null;
  readonly leaseEpoch: number;
  readonly leaseExpiresAt: Date | null;
};

export type MongoInsightsReportMember = {
  readonly _id: string;
  readonly jobId: string;
  readonly section: "summary" | "movementSeries" | "movementCohorts";
  readonly metric: "installed" | "recovered";
  readonly label: string;
  readonly bucketStartMs: number;
  readonly installKey: string;
};

export type MongoInsightsReportLatest = {
  readonly _id: string;
  readonly jobId: string;
  readonly installKey: string;
  readonly installId: string;
  readonly event: BundleEventRow;
};

export type MongoInsightsReportBucket = {
  readonly _id: string;
  readonly jobId: string;
  readonly installKey: string;
  readonly installId: string;
  readonly bucketStartMs: number;
  readonly event: BundleEventRow;
};

export type MongoInsightsReportCount = {
  readonly _id: string;
  readonly jobId: string;
  readonly section:
    | "summary"
    | "movementSeries"
    | "movementCohorts"
    | "bundleDistribution"
    | "activeSeries"
    | "activeBundleSeries"
    | "activeBundleTotals";
  readonly metric: "" | "installed" | "recovered";
  readonly label: string;
  readonly labelOrderKey: string;
  readonly labelCursorKey: string;
  readonly bucketStartMs: number;
  readonly value: number;
};

export type MongoInsightsReportOrder = {
  readonly _id: string;
  readonly jobId: string;
  readonly section:
    | "movementCohorts"
    | "bundleDistribution"
    | "activeBundleTotals";
  readonly metric: "" | "installed" | "recovered";
  readonly ordinal: Long;
  readonly label: string;
  readonly labelOrderKey: string;
  readonly value: number;
};

export type MongoInsightsModelCollections = {
  readonly projectionState: Collection<MongoInsightsProjectionState>;
  readonly projectionEvents: Collection<MongoInsightsProjectionEvent>;
  readonly installations: Collection<MongoInsightsInstallation>;
  readonly aliases: Collection<MongoInsightsAlias>;
  readonly liveSnapshots: Collection<MongoInsightsLiveSnapshot>;
  readonly searchHeads: Collection<MongoInsightsSearchHead>;
  readonly searchJobs: Collection<MongoInsightsSearchJob>;
  readonly searchRows: Collection<MongoInsightsSearchRow>;
  readonly reportHeads: Collection<MongoInsightsReportHead>;
  readonly reportJobs: Collection<MongoInsightsReportJob>;
  readonly reportMembers: Collection<MongoInsightsReportMember>;
  readonly reportLatest: Collection<MongoInsightsReportLatest>;
  readonly reportBuckets: Collection<MongoInsightsReportBucket>;
  readonly reportCounts: Collection<MongoInsightsReportCount>;
  readonly reportOrder: Collection<MongoInsightsReportOrder>;
};

export type MongoInsightsStepUsage = {
  items: number;
  requests: number;
  bytes: number;
};

const addDocumentBytes = async (
  usage: MongoInsightsStepUsage,
  value: unknown,
): Promise<void> => {
  if (ArrayBuffer.isView(value)) {
    usage.bytes += value.byteLength;
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const { BSON } = await import("mongodb");
  usage.bytes += BSON.calculateObjectSize(value as Document);
};

export const measureMongoInsightsCollection = <TRow extends Document>(
  collection: Collection<TRow>,
  usage: MongoInsightsStepUsage | undefined,
): Collection<TRow> => {
  if (usage === undefined) return collection;
  const measuredCursor = (cursor: object): object => {
    let proxy: object;
    proxy = new Proxy(cursor, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        if (property === "toArray")
          return async () => {
            usage.requests += 1;
            const rows = (await Reflect.apply(member, target, [])) as unknown[];
            for (const row of rows) await addDocumentBytes(usage, row);
            return rows;
          };
        return (...args: unknown[]) => {
          const result = Reflect.apply(member, target, args);
          return result === target ? proxy : result;
        };
      },
    });
    return proxy;
  };
  const immediate = new Set([
    "bulkWrite",
    "countDocuments",
    "deleteMany",
    "deleteOne",
    "findOne",
    "findOneAndDelete",
    "findOneAndReplace",
    "findOneAndUpdate",
    "insertMany",
    "insertOne",
    "replaceOne",
    "updateMany",
    "updateOne",
  ]);
  return new Proxy(collection, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      if (property === "find" || property === "listIndexes")
        return (...args: unknown[]) =>
          measuredCursor(Reflect.apply(member, target, args));
      if (typeof property === "string" && immediate.has(property))
        return async (...args: unknown[]) => {
          usage.requests += 1;
          const result = await Reflect.apply(member, target, args);
          if (property === "findOne" || property.startsWith("findOneAnd"))
            await addDocumentBytes(usage, result);
          return result;
        };
      return member.bind(target);
    },
  });
};

export const createMongoInsightsModelCollections = (
  client: MongoClient,
  usage?: MongoInsightsStepUsage,
): MongoInsightsModelCollections => {
  const database = client.db();
  return {
    projectionState: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION),
      usage,
    ),
    projectionEvents: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION),
      usage,
    ),
    installations: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_INSTALLATION_COLLECTION),
      usage,
    ),
    aliases: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_ALIAS_COLLECTION),
      usage,
    ),
    liveSnapshots: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_LIVE_SNAPSHOT_COLLECTION),
      usage,
    ),
    searchHeads: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_SEARCH_HEAD_COLLECTION),
      usage,
    ),
    searchJobs: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_SEARCH_JOB_COLLECTION),
      usage,
    ),
    searchRows: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_SEARCH_ROW_COLLECTION),
      usage,
    ),
    reportHeads: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_REPORT_HEAD_COLLECTION),
      usage,
    ),
    reportJobs: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_REPORT_JOB_COLLECTION),
      usage,
    ),
    reportMembers: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_REPORT_MEMBER_COLLECTION),
      usage,
    ),
    reportLatest: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_REPORT_LATEST_COLLECTION),
      usage,
    ),
    reportBuckets: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_REPORT_BUCKET_COLLECTION),
      usage,
    ),
    reportCounts: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_REPORT_COUNT_COLLECTION),
      usage,
    ),
    reportOrder: measureMongoInsightsCollection(
      database.collection(MONGO_INSIGHTS_REPORT_ORDER_COLLECTION),
      usage,
    ),
  };
};

export const emptyMongoInsightsSourceCounters = (zero: Long): readonly Long[] =>
  Array.from({ length: MONGO_INSIGHTS_SOURCE_SHARDS }, () => zero);
