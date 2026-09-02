import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
} from "@hot-updater/plugin-core";
import {
  assertInsightsMaintenanceInputContract,
  INSIGHTS_EVENT_ID_PATTERN,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_MAINTENANCE_MAX_ITEMS,
  INSIGHTS_MAINTENANCE_MAX_REQUESTS,
} from "@hot-updater/plugin-core/internal";
import {
  BSON,
  Long,
  type CollectionInfo,
  type Document,
  type MongoClient,
} from "mongodb";

import { stepMongoInsightsSearch } from "../adapters/mongodbInsightsInstallations";
import {
  createMongoInsightsModelCollections,
  emptyMongoInsightsSourceCounters,
  MONGO_INSIGHTS_ALIAS_COLLECTION,
  MONGO_INSIGHTS_INSTALLATION_COLLECTION,
  MONGO_INSIGHTS_LIVE_SNAPSHOT_COLLECTION,
  MONGO_INSIGHTS_MODEL_COLLECTIONS,
  measureMongoInsightsCollection,
  type MongoInsightsModelCollectionName,
  type MongoInsightsModelCollections,
  type MongoInsightsReportJob,
  type MongoInsightsStepUsage,
  MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION,
  MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
  MONGO_INSIGHTS_PROJECTION_STATE_ID,
  MONGO_INSIGHTS_REPORT_BUCKET_COLLECTION,
  MONGO_INSIGHTS_REPORT_COUNT_COLLECTION,
  MONGO_INSIGHTS_REPORT_HEAD_COLLECTION,
  MONGO_INSIGHTS_REPORT_JOB_COLLECTION,
  MONGO_INSIGHTS_REPORT_LATEST_COLLECTION,
  MONGO_INSIGHTS_REPORT_MEMBER_COLLECTION,
  MONGO_INSIGHTS_REPORT_ORDER_COLLECTION,
  MONGO_INSIGHTS_SEARCH_HEAD_COLLECTION,
  MONGO_INSIGHTS_SEARCH_JOB_COLLECTION,
  MONGO_INSIGHTS_SEARCH_ROW_COLLECTION,
  type MongoInsightsSearchJob,
} from "../adapters/mongodbInsightsModelSchema";
import {
  assertMongoInsightsProjectionState,
  materializeMongoInsightsProjectionEvent,
} from "../adapters/mongodbInsightsProjection";
import { stepMongoInsightsReport } from "../adapters/mongodbInsightsReports";
import {
  isMongoInsightsDatabaseNamespace,
  MONGO_INSIGHTS_DATABASE_NAMESPACE_PATTERN,
  MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
  MONGO_INSIGHTS_SOURCE_SHARDS,
  MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
  MONGO_INSIGHTS_SOURCE_STATE_ID,
  type MongoInsightsSourceClock,
  type MongoInsightsSourceState,
} from "../adapters/mongodbInsightsSourceSchema";
import {
  createMongoInsightsSource,
  decodeMongoInsightsSourceGeneration,
} from "./mongoInsightsSource";

const transactionOptions = {
  readPreference: "primary" as const,
  readConcern: { level: "snapshot" as const },
  writeConcern: { w: "majority" as const },
};

const COLLECTIONS = MONGO_INSIGHTS_MODEL_COLLECTIONS;
const nonnegativeNumber = {
  bsonType: ["int", "long", "double"],
  minimum: 0,
};
const nullableString = { bsonType: ["string", "null"] };
const nullableDate = { bsonType: ["date", "null"] };
const schema = (
  required: readonly string[],
  properties: Readonly<Record<string, Document>>,
): Document => ({
  $jsonSchema: {
    bsonType: "object",
    additionalProperties: false,
    required,
    properties,
  },
});
const jobProperties = {
  _id: { bsonType: "string" },
  state: { enum: ["queued", "preparing", "ready", "failed"] },
  sourceId: {
    bsonType: "string",
    pattern: MONGO_INSIGHTS_DATABASE_NAMESPACE_PATTERN.source,
  },
  sourceGeneration: { bsonType: "string" },
  projectionUpper: { bsonType: "long", minimum: 0 },
  asOfMs: nonnegativeNumber,
  completedAtMs: {
    bsonType: ["int", "long", "double", "null"],
    minimum: 0,
  },
  leaseOwner: nullableString,
  leaseEpoch: nonnegativeNumber,
  leaseExpiresAt: nullableDate,
};
const COLLECTION_VALIDATORS: Readonly<
  Record<MongoInsightsModelCollectionName, Document>
> = {
  [MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION]: schema(
    [
      "_id",
      "version",
      "revision",
      "phase",
      "sourceId",
      "targetGeneration",
      "shard",
      "sourceCounters",
      "nextProjectionSequence",
      "poisonEventId",
      "collectionUuids",
    ],
    {
      _id: { enum: [MONGO_INSIGHTS_PROJECTION_STATE_ID] },
      version: { enum: [1] },
      revision: nonnegativeNumber,
      phase: { enum: ["building", "ready", "failed"] },
      sourceId: {
        bsonType: "string",
        pattern: MONGO_INSIGHTS_DATABASE_NAMESPACE_PATTERN.source,
      },
      targetGeneration: { bsonType: "string" },
      shard: {
        bsonType: ["int", "long", "double"],
        minimum: 0,
        maximum: MONGO_INSIGHTS_SOURCE_SHARDS,
      },
      sourceCounters: {
        bsonType: "array",
        minItems: MONGO_INSIGHTS_SOURCE_SHARDS,
        maxItems: MONGO_INSIGHTS_SOURCE_SHARDS,
        items: { bsonType: "long", minimum: 0 },
      },
      nextProjectionSequence: { bsonType: "long", minimum: 0 },
      poisonEventId: nullableString,
      collectionUuids: {
        bsonType: "object",
        additionalProperties: false,
        required: [...COLLECTIONS],
        properties: Object.fromEntries(
          COLLECTIONS.map((name) => [name, { bsonType: "string" }]),
        ),
      },
    },
  ),
  [MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION]: schema(
    [
      "_id",
      "sourceId",
      "sourceShard",
      "sourceSequence",
      "projectionSequence",
      "latestVersion",
      "installKey",
      "installId",
      "event",
    ],
    {
      _id: { bsonType: "string", pattern: INSIGHTS_EVENT_ID_PATTERN.source },
      sourceId: {
        bsonType: "string",
        pattern: MONGO_INSIGHTS_DATABASE_NAMESPACE_PATTERN.source,
      },
      sourceShard: nonnegativeNumber,
      sourceSequence: { bsonType: "long", minimum: 1 },
      projectionSequence: { bsonType: "long", minimum: 1 },
      latestVersion: { bsonType: "bool" },
      installKey: { bsonType: "string" },
      installId: { bsonType: "string" },
      event: { bsonType: "object" },
    },
  ),
  [MONGO_INSIGHTS_INSTALLATION_COLLECTION]: schema(
    ["_id", "installId", "firstProjectionSequence"],
    {
      _id: { bsonType: "string" },
      installId: { bsonType: "string" },
      firstProjectionSequence: { bsonType: "long", minimum: 1 },
    },
  ),
  [MONGO_INSIGHTS_ALIAS_COLLECTION]: schema(
    [
      "_id",
      "kind",
      "value",
      "normalized",
      "installKey",
      "installId",
      "firstProjectionSequence",
    ],
    {
      _id: { bsonType: "string" },
      kind: { enum: ["install", "user", "username"] },
      value: { bsonType: "string" },
      normalized: { bsonType: "string" },
      installKey: { bsonType: "string" },
      installId: { bsonType: "string" },
      firstProjectionSequence: { bsonType: "long", minimum: 1 },
    },
  ),
  [MONGO_INSIGHTS_LIVE_SNAPSHOT_COLLECTION]: schema(
    [
      "_id",
      "kind",
      "installId",
      "sourceId",
      "sourceGeneration",
      "projectionUpper",
      "observedAtMs",
      "atClusterTimeSeconds",
      "atClusterTimeIncrement",
    ],
    {
      _id: { bsonType: "string" },
      kind: { enum: ["all", "installationId"] },
      installId: nullableString,
      sourceId: {
        bsonType: "string",
        pattern: MONGO_INSIGHTS_DATABASE_NAMESPACE_PATTERN.source,
      },
      sourceGeneration: { bsonType: "string" },
      projectionUpper: { bsonType: "long", minimum: 0 },
      observedAtMs: nonnegativeNumber,
      atClusterTimeSeconds: nonnegativeNumber,
      atClusterTimeIncrement: nonnegativeNumber,
    },
  ),
  [MONGO_INSIGHTS_SEARCH_HEAD_COLLECTION]: schema(
    ["_id", "descriptor", "activeJobId", "publicationJobId"],
    {
      _id: { bsonType: "string" },
      descriptor: { bsonType: "object" },
      activeJobId: nullableString,
      publicationJobId: nullableString,
    },
  ),
  [MONGO_INSIGHTS_SEARCH_JOB_COLLECTION]: schema(
    [
      ...Object.keys(jobProperties),
      "queryHash",
      "descriptor",
      "afterAliasSequence",
      "afterAliasId",
      "total",
    ],
    {
      ...jobProperties,
      queryHash: { bsonType: "string" },
      descriptor: { bsonType: "object" },
      afterAliasSequence: { bsonType: ["long", "null"], minimum: 0 },
      afterAliasId: nullableString,
      total: { bsonType: ["int", "long", "double", "null"], minimum: 0 },
    },
  ),
  [MONGO_INSIGHTS_SEARCH_ROW_COLLECTION]: schema(
    ["_id", "jobId", "installKey", "installId", "event"],
    {
      _id: { bsonType: "string" },
      jobId: { bsonType: "string" },
      installKey: { bsonType: "string" },
      installId: { bsonType: "string" },
      event: { bsonType: "object" },
    },
  ),
  [MONGO_INSIGHTS_REPORT_HEAD_COLLECTION]: schema(
    ["_id", "query", "activeJobId", "publicationJobId"],
    {
      _id: { bsonType: "string" },
      query: { bsonType: "object" },
      activeJobId: nullableString,
      publicationJobId: nullableString,
    },
  ),
  [MONGO_INSIGHTS_REPORT_JOB_COLLECTION]: schema(
    [
      ...Object.keys(jobProperties),
      "queryHash",
      "query",
      "phase",
      "afterProjectionSequence",
      "afterInstallKey",
      "afterBucketId",
      "orderSection",
      "orderAfterValue",
      "orderAfterKey",
      "orderAfterId",
      "nextOrdinal",
      "orderTotals",
      "publishIndex",
      "publishBundleSummaries",
      "publication",
    ],
    {
      ...jobProperties,
      queryHash: { bsonType: "string" },
      query: { bsonType: "object" },
      phase: {
        enum: ["source", "installations", "buckets", "order", "publish"],
      },
      afterProjectionSequence: { bsonType: "long", minimum: 0 },
      afterInstallKey: nullableString,
      afterBucketId: nullableString,
      orderSection: nonnegativeNumber,
      orderAfterValue: {
        bsonType: ["int", "long", "double", "null"],
        minimum: 0,
      },
      orderAfterKey: nullableString,
      orderAfterId: nullableString,
      nextOrdinal: { bsonType: "long", minimum: 0 },
      orderTotals: { bsonType: "array" },
      publishIndex: nonnegativeNumber,
      publishBundleSummaries: { bsonType: "array" },
      publication: { bsonType: ["object", "null"] },
    },
  ),
  [MONGO_INSIGHTS_REPORT_MEMBER_COLLECTION]: schema(
    [
      "_id",
      "jobId",
      "section",
      "metric",
      "label",
      "bucketStartMs",
      "installKey",
    ],
    {
      _id: { bsonType: "string" },
      jobId: { bsonType: "string" },
      section: { enum: ["summary", "movementSeries", "movementCohorts"] },
      metric: { enum: ["installed", "recovered"] },
      label: { bsonType: "string" },
      bucketStartMs: { bsonType: ["int", "long", "double"] },
      installKey: { bsonType: "string" },
    },
  ),
  [MONGO_INSIGHTS_REPORT_LATEST_COLLECTION]: schema(
    ["_id", "jobId", "installKey", "installId", "event"],
    {
      _id: { bsonType: "string" },
      jobId: { bsonType: "string" },
      installKey: { bsonType: "string" },
      installId: { bsonType: "string" },
      event: { bsonType: "object" },
    },
  ),
  [MONGO_INSIGHTS_REPORT_BUCKET_COLLECTION]: schema(
    ["_id", "jobId", "installKey", "installId", "bucketStartMs", "event"],
    {
      _id: { bsonType: "string" },
      jobId: { bsonType: "string" },
      installKey: { bsonType: "string" },
      installId: { bsonType: "string" },
      bucketStartMs: nonnegativeNumber,
      event: { bsonType: "object" },
    },
  ),
  [MONGO_INSIGHTS_REPORT_COUNT_COLLECTION]: schema(
    [
      "_id",
      "jobId",
      "section",
      "metric",
      "label",
      "labelOrderKey",
      "labelCursorKey",
      "bucketStartMs",
      "value",
    ],
    {
      _id: { bsonType: "string" },
      jobId: { bsonType: "string" },
      section: {
        enum: [
          "summary",
          "movementSeries",
          "movementCohorts",
          "bundleDistribution",
          "activeSeries",
          "activeBundleSeries",
          "activeBundleTotals",
        ],
      },
      metric: { enum: ["", "installed", "recovered"] },
      label: { bsonType: "string" },
      labelOrderKey: { bsonType: "string" },
      labelCursorKey: { bsonType: "string" },
      bucketStartMs: { bsonType: ["int", "long", "double"] },
      value: nonnegativeNumber,
    },
  ),
  [MONGO_INSIGHTS_REPORT_ORDER_COLLECTION]: schema(
    [
      "_id",
      "jobId",
      "section",
      "metric",
      "ordinal",
      "label",
      "labelOrderKey",
      "value",
    ],
    {
      _id: { bsonType: "string" },
      jobId: { bsonType: "string" },
      section: {
        enum: ["movementCohorts", "bundleDistribution", "activeBundleTotals"],
      },
      metric: { enum: ["", "installed", "recovered"] },
      ordinal: { bsonType: "long", minimum: 0 },
      label: { bsonType: "string" },
      labelOrderKey: { bsonType: "string" },
      value: nonnegativeNumber,
    },
  ),
};

const assertCollectionReady = async (
  client: MongoClient,
  name: (typeof COLLECTIONS)[number],
): Promise<void> => {
  const collection = await client
    .db()
    .listCollections({ name }, { nameOnly: false })
    .next();
  if (
    !collection ||
    collection.options?.validationLevel !== "strict" ||
    collection.options.validationAction !== "error" ||
    (collection.options.collation !== undefined &&
      collection.options.collation.locale !== "simple") ||
    BSON.EJSON.stringify(collection.options.validator ?? {}, {
      relaxed: false,
    }) !== BSON.EJSON.stringify(COLLECTION_VALIDATORS[name], { relaxed: false })
  )
    throw new InsightsQueryNotReadyError();
};

const collectionUuid = (collection: CollectionInfo | undefined): string => {
  if (!collection?.info?.uuid) throw new InsightsQueryNotReadyError();
  return BSON.EJSON.stringify(collection.info.uuid, { relaxed: false });
};

const readCollectionUuids = async (
  client: MongoClient,
): Promise<Readonly<Record<MongoInsightsModelCollectionName, string>>> => {
  const metadata = await client
    .db()
    .listCollections({ name: { $in: [...COLLECTIONS] } }, { nameOnly: false })
    .toArray();
  const byName = new Map(metadata.map((item) => [item.name, item]));
  if (byName.size !== COLLECTIONS.length)
    throw new InsightsQueryNotReadyError();
  return Object.fromEntries(
    COLLECTIONS.map((name) => [name, collectionUuid(byName.get(name))]),
  ) as Readonly<Record<MongoInsightsModelCollectionName, string>>;
};

const assertCollectionUuids = async (
  client: MongoClient,
  expected: Readonly<Record<MongoInsightsModelCollectionName, string>>,
): Promise<void> => {
  const actual = await readCollectionUuids(client);
  if (COLLECTIONS.some((name) => actual[name] !== expected[name]))
    throw new InsightsQueryNotReadyError();
};

const createCollection = async (
  client: MongoClient,
  name: (typeof COLLECTIONS)[number],
): Promise<void> => {
  try {
    await client.db().createCollection(name, {
      collation: { locale: "simple" },
      validator: COLLECTION_VALIDATORS[name],
      validationLevel: "strict",
      validationAction: "error",
    });
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      Reflect.get(error, "code") !== 48
    )
      throw error;
    await client.db().command({
      collMod: name,
      validator: COLLECTION_VALIDATORS[name],
      validationLevel: "strict",
      validationAction: "error",
    });
  }
  await assertCollectionReady(client, name);
};

const ensureIndex = async (
  collection: MongoInsightsModelCollections[keyof MongoInsightsModelCollections],
  name: string,
  key: Document,
  unique = false,
  repair = true,
): Promise<void> => {
  const existing = (await collection.listIndexes().toArray()).find(
    (index) => index.name === name,
  );
  const compatible =
    existing !== undefined &&
    JSON.stringify(Object.entries(existing.key)) ===
      JSON.stringify(Object.entries(key)) &&
    (existing.unique === true) === unique &&
    existing.hidden !== true &&
    existing.sparse !== true &&
    existing.partialFilterExpression === undefined &&
    (existing.collation === undefined ||
      existing.collation.locale === "simple");
  if (compatible) return;
  if (!repair) throw new InsightsQueryNotReadyError();
  if (existing) await collection.dropIndex(name);
  await collection.createIndex(key, {
    name,
    unique,
    collation: { locale: "simple" },
  });
};

const ensureIndexes = async (
  collections: MongoInsightsModelCollections,
  repair = true,
): Promise<void> => {
  const ensure = (
    collection: MongoInsightsModelCollections[keyof MongoInsightsModelCollections],
    name: string,
    key: Document,
    unique = false,
  ) => ensureIndex(collection, name, key, unique, repair);
  await ensure(
    collections.projectionEvents,
    "insights_projection_sequence_idx",
    { projectionSequence: 1 },
    true,
  );
  await ensure(
    collections.projectionEvents,
    "insights_projection_source_idx",
    { sourceId: 1, sourceShard: 1, sourceSequence: 1 },
    true,
  );
  await ensure(
    collections.projectionEvents,
    "insights_projection_install_latest_idx",
    {
      installKey: 1,
      latestVersion: 1,
      projectionSequence: -1,
    },
  );
  await ensure(
    collections.projectionEvents,
    "insights_projection_received_idx",
    {
      "event.received_at_ms": 1,
      _id: 1,
      projectionSequence: 1,
    },
  );
  await ensure(
    collections.projectionEvents,
    "insights_projection_install_event_idx",
    {
      installKey: 1,
      "event.type": 1,
      "event.received_at_ms": 1,
      _id: 1,
      projectionSequence: 1,
    },
  );
  await ensure(
    collections.projectionEvents,
    "insights_projection_to_bundle_event_idx",
    {
      "event.type": 1,
      "event.to_bundle_id": 1,
      "event.received_at_ms": 1,
      _id: 1,
      projectionSequence: 1,
    },
  );
  await ensure(
    collections.projectionEvents,
    "insights_projection_from_bundle_event_idx",
    {
      "event.type": 1,
      "event.from_bundle_id": 1,
      "event.received_at_ms": 1,
      _id: 1,
      projectionSequence: 1,
    },
  );
  await ensure(collections.aliases, "insights_alias_exact_idx", {
    kind: 1,
    value: 1,
    firstProjectionSequence: 1,
    _id: 1,
  });
  await ensure(collections.aliases, "insights_alias_scan_idx", {
    firstProjectionSequence: 1,
    _id: 1,
  });
  await ensure(collections.searchJobs, "insights_search_job_state_idx", {
    state: 1,
    asOfMs: 1,
    _id: 1,
  });
  await ensure(
    collections.searchRows,
    "insights_search_rows_idx",
    { jobId: 1, installKey: 1 },
    true,
  );
  await ensure(collections.reportJobs, "insights_report_job_state_idx", {
    state: 1,
    asOfMs: 1,
    _id: 1,
  });
  await ensure(collections.reportMembers, "insights_report_members_idx", {
    jobId: 1,
    section: 1,
    metric: 1,
    label: 1,
    bucketStartMs: 1,
    installKey: 1,
  });
  await ensure(
    collections.reportLatest,
    "insights_report_latest_idx",
    { jobId: 1, installKey: 1 },
    true,
  );
  await ensure(
    collections.reportBuckets,
    "insights_report_buckets_idx",
    { jobId: 1, installKey: 1, bucketStartMs: 1 },
    true,
  );
  await ensure(
    collections.reportCounts,
    "insights_report_count_label_order_idx",
    {
      jobId: 1,
      section: 1,
      metric: 1,
      bucketStartMs: 1,
      labelCursorKey: 1,
    },
  );
  await ensure(
    collections.reportCounts,
    "insights_report_count_value_order_idx",
    {
      jobId: 1,
      section: 1,
      metric: 1,
      bucketStartMs: 1,
      value: -1,
      labelOrderKey: 1,
      _id: 1,
    },
  );
  await ensure(
    collections.reportOrder,
    "insights_report_order_idx",
    { jobId: 1, section: 1, metric: 1, ordinal: 1 },
    true,
  );
  const expected: Readonly<
    Record<MongoInsightsModelCollectionName, readonly string[]>
  > = {
    [MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION]: [],
    [MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION]: [
      "insights_projection_sequence_idx",
      "insights_projection_source_idx",
      "insights_projection_install_latest_idx",
      "insights_projection_received_idx",
      "insights_projection_install_event_idx",
      "insights_projection_to_bundle_event_idx",
      "insights_projection_from_bundle_event_idx",
    ],
    [MONGO_INSIGHTS_INSTALLATION_COLLECTION]: [],
    [MONGO_INSIGHTS_ALIAS_COLLECTION]: [
      "insights_alias_exact_idx",
      "insights_alias_scan_idx",
    ],
    [MONGO_INSIGHTS_LIVE_SNAPSHOT_COLLECTION]: [],
    [MONGO_INSIGHTS_SEARCH_HEAD_COLLECTION]: [],
    [MONGO_INSIGHTS_SEARCH_JOB_COLLECTION]: ["insights_search_job_state_idx"],
    [MONGO_INSIGHTS_SEARCH_ROW_COLLECTION]: ["insights_search_rows_idx"],
    [MONGO_INSIGHTS_REPORT_HEAD_COLLECTION]: [],
    [MONGO_INSIGHTS_REPORT_JOB_COLLECTION]: ["insights_report_job_state_idx"],
    [MONGO_INSIGHTS_REPORT_MEMBER_COLLECTION]: ["insights_report_members_idx"],
    [MONGO_INSIGHTS_REPORT_LATEST_COLLECTION]: ["insights_report_latest_idx"],
    [MONGO_INSIGHTS_REPORT_BUCKET_COLLECTION]: ["insights_report_buckets_idx"],
    [MONGO_INSIGHTS_REPORT_COUNT_COLLECTION]: [
      "insights_report_count_label_order_idx",
      "insights_report_count_value_order_idx",
    ],
    [MONGO_INSIGHTS_REPORT_ORDER_COLLECTION]: ["insights_report_order_idx"],
  };
  const byName: Readonly<
    Record<
      MongoInsightsModelCollectionName,
      MongoInsightsModelCollections[keyof MongoInsightsModelCollections]
    >
  > = {
    [MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION]: collections.projectionState,
    [MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION]: collections.projectionEvents,
    [MONGO_INSIGHTS_INSTALLATION_COLLECTION]: collections.installations,
    [MONGO_INSIGHTS_ALIAS_COLLECTION]: collections.aliases,
    [MONGO_INSIGHTS_LIVE_SNAPSHOT_COLLECTION]: collections.liveSnapshots,
    [MONGO_INSIGHTS_SEARCH_HEAD_COLLECTION]: collections.searchHeads,
    [MONGO_INSIGHTS_SEARCH_JOB_COLLECTION]: collections.searchJobs,
    [MONGO_INSIGHTS_SEARCH_ROW_COLLECTION]: collections.searchRows,
    [MONGO_INSIGHTS_REPORT_HEAD_COLLECTION]: collections.reportHeads,
    [MONGO_INSIGHTS_REPORT_JOB_COLLECTION]: collections.reportJobs,
    [MONGO_INSIGHTS_REPORT_MEMBER_COLLECTION]: collections.reportMembers,
    [MONGO_INSIGHTS_REPORT_LATEST_COLLECTION]: collections.reportLatest,
    [MONGO_INSIGHTS_REPORT_BUCKET_COLLECTION]: collections.reportBuckets,
    [MONGO_INSIGHTS_REPORT_COUNT_COLLECTION]: collections.reportCounts,
    [MONGO_INSIGHTS_REPORT_ORDER_COLLECTION]: collections.reportOrder,
  };
  for (const name of COLLECTIONS) {
    const indexes = await byName[name].listIndexes().toArray();
    const allowed = new Set(["_id_", ...expected[name]]);
    const id = indexes.find((index) => index.name === "_id_");
    if (
      !id ||
      JSON.stringify(Object.entries(id.key)) !==
        JSON.stringify(Object.entries({ _id: 1 })) ||
      id.hidden === true ||
      id.sparse === true ||
      id.partialFilterExpression !== undefined ||
      (id.collation !== undefined && id.collation.locale !== "simple")
    )
      throw new InsightsQueryNotReadyError();
    const unexpected = indexes.filter(
      (index) => index.name === undefined || !allowed.has(index.name),
    );
    if (unexpected.length === 0) continue;
    if (!repair) throw new InsightsQueryNotReadyError();
    for (const index of unexpected) {
      if (index.name === undefined) throw new InsightsQueryNotReadyError();
      await byName[name].dropIndex(index.name);
    }
  }
};

const sameCounters = (
  left: readonly Long[],
  right: readonly bigint[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value.toBigInt() === right[index]);

const assertStepUsage = (
  usage: MongoInsightsStepUsage,
  input: { readonly maxItems: number; readonly maxRequests: number },
): void => {
  if (
    !Number.isSafeInteger(usage.items) ||
    usage.items < 0 ||
    usage.items > input.maxItems ||
    !Number.isSafeInteger(usage.requests) ||
    usage.requests < 0 ||
    usage.requests > input.maxRequests ||
    !Number.isSafeInteger(usage.bytes) ||
    usage.bytes < 0 ||
    usage.bytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
  )
    throw new DatabasePluginInputError("invalid-result");
};

const markFailed = async (
  collections: MongoInsightsModelCollections,
  eventId: string | null,
): Promise<void> => {
  await collections.projectionState.updateOne(
    { _id: MONGO_INSIGHTS_PROJECTION_STATE_ID, phase: "building" },
    {
      $set: { phase: "failed", poisonEventId: eventId },
      $inc: { revision: 1 },
    },
  );
};

const jobStepBudget = (
  work:
    | { readonly kind: "search"; readonly job: MongoInsightsSearchJob }
    | { readonly kind: "report"; readonly job: MongoInsightsReportJob },
  input: { readonly maxItems: number; readonly maxRequests: number },
  selectionRequests: number,
): { readonly limit: number } | null => {
  let fixedRequests: number;
  let requestsPerItem: number;
  if (work.kind === "search") {
    fixedRequests = selectionRequests + 6;
    requestsPerItem = 2;
  } else {
    switch (work.job.phase) {
      case "source":
        fixedRequests = selectionRequests + 4;
        requestsPerItem = work.job.query.kind === "bundleDetail" ? 6 : 4;
        break;
      case "installations":
        fixedRequests = selectionRequests + 4;
        requestsPerItem = 2;
        break;
      case "buckets":
        fixedRequests = selectionRequests + 4;
        requestsPerItem = 4;
        break;
      case "order":
        fixedRequests = selectionRequests + 4;
        requestsPerItem = 1;
        break;
      case "publish":
        if (
          work.job.query.kind === "bundleSummaries" &&
          work.job.publishIndex < work.job.query.bundleIds.length
        ) {
          fixedRequests = selectionRequests + 3;
          requestsPerItem = 2;
        } else {
          fixedRequests =
            selectionRequests +
            (work.job.query.kind === "bundleDetail"
              ? 6
              : work.job.query.kind === "bundleSummaries"
                ? 4
                : 5);
          requestsPerItem = 0;
        }
        break;
    }
  }
  if (fixedRequests > input.maxRequests) return null;
  const requestCapacity =
    requestsPerItem === 0
      ? 1
      : Math.floor((input.maxRequests - fixedRequests) / requestsPerItem);
  const limit = Math.min(100, input.maxItems, requestCapacity);
  if (limit < 1) return null;
  return { limit };
};

export const createMongoInsightsModelMaintenance = (
  client: MongoClient,
  databaseNamespace: string,
) => {
  if (!isMongoInsightsDatabaseNamespace(databaseNamespace))
    throw new DatabasePluginInputError("invalid-query");
  const collections = createMongoInsightsModelCollections(client);
  const source = createMongoInsightsSource(client, databaseNamespace);

  const runProjectionStep = async (
    limit: number,
    usage: MongoInsightsStepUsage,
  ) => {
    const collections = createMongoInsightsModelCollections(client, usage);
    const source = createMongoInsightsSource(client, databaseNamespace, usage);
    const state = assertMongoInsightsProjectionState(
      await collections.projectionState.findOne(
        { _id: MONGO_INSIGHTS_PROJECTION_STATE_ID },
        { promoteLongs: false },
      ),
    );
    if (state.sourceId !== databaseNamespace)
      throw new InsightsQueryNotReadyError();
    if (state.phase === "failed") throw new InsightsQueryNotReadyError();
    if (state.phase === "ready")
      return { state: "ready" as const, processed: 0 };
    if (state.shard === MONGO_INSIGHTS_SOURCE_SHARDS) {
      const generation = await source.capture();
      const decoded = decodeMongoInsightsSourceGeneration(generation);
      if (!sameCounters(state.sourceCounters, decoded.counters)) {
        const saved = await collections.projectionState.updateOne(
          { _id: state._id, revision: state.revision, phase: "building" },
          {
            $set: { targetGeneration: generation, shard: 0 },
            $inc: { revision: 1 },
          },
        );
        if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
        return { state: "building" as const, processed: 0 };
      }
      await client.withSession((session) =>
        session.withTransaction(async () => {
          const current = assertMongoInsightsProjectionState(
            await collections.projectionState.findOne(
              { _id: state._id },
              { session, promoteLongs: false },
            ),
          );
          if (current.sourceId !== databaseNamespace)
            throw new InsightsQueryNotReadyError();
          const sourceState = await measureMongoInsightsCollection(
            client
              .db()
              .collection<MongoInsightsSourceState>(
                MONGO_INSIGHTS_SOURCE_STATE_COLLECTION,
              ),
            usage,
          ).findOne({ _id: MONGO_INSIGHTS_SOURCE_STATE_ID }, { session });
          const clocks = await measureMongoInsightsCollection(
            client
              .db()
              .collection<MongoInsightsSourceClock>(
                MONGO_INSIGHTS_SOURCE_CLOCK_COLLECTION,
              ),
            usage,
          )
            .find(
              { sourceId: current.sourceId },
              { session, promoteLongs: false },
            )
            .sort({ _id: 1 })
            .limit(MONGO_INSIGHTS_SOURCE_SHARDS + 1)
            .toArray();
          if (
            sourceState?.phase !== "ready" ||
            sourceState.sourceId !== current.sourceId ||
            clocks.length !== MONGO_INSIGHTS_SOURCE_SHARDS ||
            clocks.some(
              (clock, shard) =>
                clock._id !== shard ||
                !Long.isLong(clock.value) ||
                !clock.value.equals(current.sourceCounters[shard]!),
            )
          )
            throw new InsightsQueryNotReadyError();
          const saved = await collections.projectionState.updateOne(
            { _id: current._id, revision: current.revision, phase: "building" },
            {
              $set: { phase: "ready", poisonEventId: null },
              $inc: { revision: 1 },
            },
            { session },
          );
          if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
        }, transactionOptions),
      );
      return { state: "ready" as const, processed: 0 };
    }
    const after = state.sourceCounters[state.shard]!.toString();
    const page = await source.readPage({
      sourceGeneration: state.targetGeneration,
      shard: state.shard,
      afterSequence: after,
      limit,
    });
    if (page.length === 0) {
      const saved = await collections.projectionState.updateOne(
        { _id: state._id, revision: state.revision, phase: "building" },
        { $set: { shard: state.shard + 1 }, $inc: { revision: 1 } },
      );
      if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
      return { state: "building" as const, processed: 0 };
    }
    let poisonEventId: string | null = null;
    try {
      await client.withSession((session) =>
        session.withTransaction(async () => {
          const current = assertMongoInsightsProjectionState(
            await collections.projectionState.findOne(
              { _id: state._id },
              { session, promoteLongs: false },
            ),
          );
          if (
            current.sourceId !== databaseNamespace ||
            current.phase !== "building" ||
            current.revision !== state.revision ||
            current.shard !== state.shard ||
            current.targetGeneration !== state.targetGeneration
          )
            throw new InsightsQueryNotReadyError();
          let previous = current.sourceCounters[current.shard]!;
          let projectionSequence = current.nextProjectionSequence;
          for (const item of page) {
            poisonEventId = item.event.id;
            const sourceSequence = Long.fromString(item.sequence);
            if (sourceSequence.toBigInt() !== previous.toBigInt() + 1n)
              throw new DatabasePluginInputError("invalid-result");
            if (projectionSequence.equals(Long.MAX_VALUE))
              throw new DatabasePluginInputError("invalid-result");
            projectionSequence = projectionSequence.add(Long.ONE);
            await materializeMongoInsightsProjectionEvent(
              collections,
              {
                event: item.event,
                sourceId: current.sourceId,
                sourceShard: current.shard,
                sourceSequence,
                projectionSequence,
              },
              session,
            );
            previous = sourceSequence;
          }
          const counterField = `sourceCounters.${current.shard}`;
          const saved = await collections.projectionState.updateOne(
            { _id: current._id, revision: current.revision, phase: "building" },
            {
              $set: {
                [counterField]: previous,
                nextProjectionSequence: projectionSequence,
              } as Document,
              $inc: { revision: 1 },
            },
            { session },
          );
          if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
        }, transactionOptions),
      );
    } catch (error) {
      if (
        error instanceof DatabasePluginInputError &&
        error.code === "invalid-result"
      )
        await markFailed(collections, poisonEventId);
      throw error;
    }
    return { state: "building" as const, processed: page.length };
  };

  return {
    async prepare(): Promise<{
      state: "building" | "ready";
      processed: number;
    }> {
      await source.ensureReady();
      for (const name of COLLECTIONS) await createCollection(client, name);
      await ensureIndexes(collections);
      const existing = await collections.projectionState.findOne(
        { _id: MONGO_INSIGHTS_PROJECTION_STATE_ID },
        { promoteLongs: false },
      );
      if (existing) {
        const state = assertMongoInsightsProjectionState(existing);
        if (state.sourceId !== databaseNamespace)
          throw new InsightsQueryNotReadyError();
        await assertCollectionUuids(client, state.collectionUuids);
        if (state.phase === "failed") throw new InsightsQueryNotReadyError();
        return { state: state.phase, processed: 0 };
      }
      const populated = await Promise.all(
        Object.values(collections)
          .filter((collection) => collection !== collections.projectionState)
          .map((collection) =>
            collection.findOne({}, { projection: { _id: 1 } }),
          ),
      );
      if (populated.some(Boolean))
        throw new DatabasePluginInputError("invalid-result");
      const generation = await source.capture();
      const decoded = decodeMongoInsightsSourceGeneration(generation);
      if (decoded.sourceId !== databaseNamespace)
        throw new InsightsQueryNotReadyError();
      const collectionUuids = await readCollectionUuids(client);
      await collections.projectionState.insertOne({
        _id: MONGO_INSIGHTS_PROJECTION_STATE_ID,
        version: 1,
        revision: 0,
        phase: "building",
        sourceId: decoded.sourceId,
        targetGeneration: generation,
        shard: 0,
        sourceCounters: emptyMongoInsightsSourceCounters(Long.ZERO),
        nextProjectionSequence: Long.ZERO,
        poisonEventId: null,
        collectionUuids,
      });
      return { state: "building", processed: 0 };
    },

    async runStep(input: {
      readonly maxItems: number;
      readonly maxRequests: number;
    }) {
      try {
        assertInsightsMaintenanceInputContract(input);
      } catch {
        throw new DatabasePluginInputError("invalid-query");
      }
      if (
        input.maxItems > INSIGHTS_MAINTENANCE_MAX_ITEMS ||
        input.maxRequests > INSIGHTS_MAINTENANCE_MAX_REQUESTS
      )
        throw new DatabasePluginInputError("invalid-query");
      if (input.maxRequests < 8)
        return {
          state: "idle" as const,
          processed: 0,
          usage: { items: 0, requests: 0, bytes: 0 },
        };
      const usage: MongoInsightsStepUsage = {
        items: 0,
        requests: 0,
        bytes: 0,
      };
      const stepCollections = createMongoInsightsModelCollections(
        client,
        usage,
      );
      const projection = await stepCollections.projectionState.findOne(
        { _id: MONGO_INSIGHTS_PROJECTION_STATE_ID },
        { promoteLongs: false },
      );
      if (!projection || projection.phase !== "ready") {
        const capacity = Math.floor((input.maxRequests - 14) / 7);
        const projectionLimit = Math.min(100, input.maxItems, capacity);
        if (projectionLimit < 1)
          return {
            state: "idle" as const,
            processed: 0,
            usage,
          };
        const result = await runProjectionStep(projectionLimit, usage);
        usage.items = result.processed;
        assertStepUsage(usage, input);
        return {
          ...result,
          usage,
        };
      }
      const [search, report] = await Promise.all([
        stepCollections.searchJobs.findOne(
          { state: { $in: ["queued", "preparing"] } },
          { sort: { asOfMs: 1, _id: 1 }, promoteLongs: false },
        ),
        stepCollections.reportJobs.findOne(
          { state: { $in: ["queued", "preparing"] } },
          { sort: { asOfMs: 1, _id: 1 }, promoteLongs: false },
        ),
      ]);
      const work =
        search && (!report || search.asOfMs <= report.asOfMs)
          ? { kind: "search" as const, job: search }
          : report
            ? { kind: "report" as const, job: report }
            : null;
      if (!work)
        return {
          state: "idle" as const,
          processed: 0,
          usage,
        };
      const budget = jobStepBudget(work, input, 3);
      if (budget === null)
        return {
          state: "idle" as const,
          processed: 0,
          jobId: work.job._id,
          usage,
        };
      let result: "progress" | "published" | "failed";
      try {
        result =
          work.kind === "search"
            ? await stepMongoInsightsSearch(
                client,
                work.job._id,
                budget.limit,
                usage,
              )
            : await stepMongoInsightsReport(
                client,
                work.job._id,
                budget.limit,
                usage,
              );
      } catch {
        const failed =
          (work.kind === "search"
            ? await stepCollections.searchJobs.findOne(
                { _id: work.job._id },
                { projection: { state: 1 } },
              )
            : await stepCollections.reportJobs.findOne(
                { _id: work.job._id },
                { projection: { state: 1 } },
              )
          )?.state === "failed";
        assertStepUsage(usage, input);
        return {
          state: failed ? ("failed" as const) : ("idle" as const),
          processed: failed ? usage.items : 0,
          jobId: work.job._id,
          usage,
        };
      }
      assertStepUsage(usage, input);
      return {
        state: result,
        processed: usage.items,
        jobId: work.job._id,
        usage,
      };
    },

    async runJobStep(
      jobId: string,
      input: { readonly maxItems: number; readonly maxRequests: number },
    ) {
      try {
        assertInsightsMaintenanceInputContract(input);
      } catch {
        throw new DatabasePluginInputError("invalid-query");
      }
      if (
        input.maxItems > INSIGHTS_MAINTENANCE_MAX_ITEMS ||
        input.maxRequests > INSIGHTS_MAINTENANCE_MAX_REQUESTS
      )
        throw new DatabasePluginInputError("invalid-query");
      if (input.maxRequests < 8)
        return {
          state: "idle" as const,
          processed: 0,
          jobId,
          usage: { items: 0, requests: 0, bytes: 0 },
        };
      const usage: MongoInsightsStepUsage = {
        items: 0,
        requests: 0,
        bytes: 0,
      };
      const stepCollections = createMongoInsightsModelCollections(
        client,
        usage,
      );
      const [search, report] = await Promise.all([
        stepCollections.searchJobs.findOne(
          { _id: jobId },
          { promoteLongs: false },
        ),
        stepCollections.reportJobs.findOne(
          { _id: jobId },
          { promoteLongs: false },
        ),
      ]);
      if (search && report)
        throw new DatabasePluginInputError("invalid-result");
      const work = search
        ? { kind: "search" as const, job: search }
        : report
          ? { kind: "report" as const, job: report }
          : null;
      if (work === null)
        return {
          state: "idle" as const,
          processed: 0,
          jobId,
          usage,
        };
      const budget = jobStepBudget(work, input, 2);
      if (budget === null)
        return {
          state: "idle" as const,
          processed: 0,
          jobId,
          usage,
        };
      let result: "progress" | "published" | "failed";
      try {
        result =
          work.kind === "search"
            ? await stepMongoInsightsSearch(client, jobId, budget.limit, usage)
            : await stepMongoInsightsReport(client, jobId, budget.limit, usage);
      } catch {
        const failed =
          (work.kind === "search"
            ? await stepCollections.searchJobs.findOne(
                { _id: jobId },
                { projection: { state: 1 } },
              )
            : await stepCollections.reportJobs.findOne(
                { _id: jobId },
                { projection: { state: 1 } },
              )
          )?.state === "failed";
        assertStepUsage(usage, input);
        return {
          state: failed ? ("failed" as const) : ("idle" as const),
          processed: failed ? usage.items : 0,
          jobId,
          usage,
        };
      }
      assertStepUsage(usage, input);
      return {
        state: result,
        processed: usage.items,
        jobId,
        usage,
      };
    },

    async ensureReady(): Promise<void> {
      for (const name of COLLECTIONS) await assertCollectionReady(client, name);
      await ensureIndexes(collections, false);
      const state = assertMongoInsightsProjectionState(
        await collections.projectionState.findOne(
          { _id: MONGO_INSIGHTS_PROJECTION_STATE_ID },
          { promoteLongs: false },
        ),
      );
      if (state.phase !== "ready") throw new InsightsQueryNotReadyError();
      await assertCollectionUuids(client, state.collectionUuids);
      await source.ensureReady();
    },
  };
};
