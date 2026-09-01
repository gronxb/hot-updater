import { randomUUID } from "node:crypto";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsPublication,
  type InsightsProjectedReadVersions,
  type InsightsPublishedReportPageData,
  type InsightsReadVersions,
  type InsightsReportInput,
  type InsightsReportPage,
  type InsightsReportPageInput,
  type InsightsReportPublication,
  type InsightsReportQuery,
  type InsightsReportResult,
} from "@hot-updater/plugin-core";
import {
  assertInsightsReportPageResultContract,
  assertInsightsReportResultContract,
  createInsightsReportPageCursor,
  createInsightsReportProjection,
  readInsightsReportPageInput,
  readInsightsReportPageQuery,
  readInsightsReportQuery,
} from "@hot-updater/plugin-core/internal";
import { Long, type ClientSession, type MongoClient } from "mongodb";

import {
  createMongoInsightsModelCollections,
  type MongoInsightsModelCollections,
  type MongoInsightsProjectionState,
  type MongoInsightsReportCount,
  type MongoInsightsReportJob,
  type MongoInsightsReportOrder,
  type MongoInsightsStepUsage,
  MONGO_INSIGHTS_PROJECTION_STATE_ID,
  MONGO_INSIGHTS_STORAGE_VERSION,
} from "./mongodbInsightsModelSchema";
import {
  assertMongoInsightsProjectionEvent,
  assertMongoInsightsProjectionSourceGeneration,
  assertMongoInsightsProjectionState,
  mongoInsightsDigest,
  mongoInsightsInstallationKey,
  mongoInsightsProjectionSourceGeneration,
} from "./mongodbInsightsProjection";

const transactionOptions = {
  readPreference: "primary" as const,
  readConcern: { level: "snapshot" as const },
  writeConcern: { w: "majority" as const },
};

const versions = (
  job: MongoInsightsReportJob,
): InsightsProjectedReadVersions => ({
  schemaVersion: "1.0.0",
  storageVersion: MONGO_INSIGHTS_STORAGE_VERSION,
  projectionGeneration: job._id,
  sourceGeneration: job.sourceGeneration,
});

const failedVersions = (): InsightsReadVersions => ({
  schemaVersion: "1.0.0",
  storageVersion: MONGO_INSIGHTS_STORAGE_VERSION,
  projectionGeneration: null,
  sourceGeneration: "unavailable",
});

const readReadyState = async (
  collections: MongoInsightsModelCollections,
  session?: ClientSession,
): Promise<MongoInsightsProjectionState> => {
  const state = assertMongoInsightsProjectionState(
    await collections.projectionState.findOne(
      { _id: MONGO_INSIGHTS_PROJECTION_STATE_ID },
      { session, promoteLongs: false },
    ),
  );
  if (state.phase !== "ready") throw new InsightsQueryNotReadyError();
  return state;
};

type ReportReservation = {
  readonly job: MongoInsightsReportJob;
  readonly previous: MongoInsightsReportJob | null;
};

const reserveReport = async (
  client: MongoClient,
  input: InsightsReportInput,
): Promise<ReportReservation> => {
  const request = readInsightsReportQuery(input);
  const queryHash = mongoInsightsDigest([
    MONGO_INSIGHTS_STORAGE_VERSION,
    request.semanticKey,
  ]);
  const collections = createMongoInsightsModelCollections(client);
  return client.withSession((session) =>
    session.withTransaction(async () => {
      const state = await readReadyState(collections, session);
      await collections.reportHeads.updateOne(
        { _id: queryHash },
        {
          $setOnInsert: {
            query: request.query,
            activeJobId: null,
            publicationJobId: null,
          },
        },
        { session, upsert: true },
      );
      const head = await collections.reportHeads.findOne(
        { _id: queryHash },
        { session },
      );
      if (!head || JSON.stringify(head.query) !== JSON.stringify(request.query))
        throw new DatabasePluginInputError("invalid-result");
      const previous = head.publicationJobId
        ? await collections.reportJobs.findOne(
            { _id: head.publicationJobId, queryHash },
            { session, promoteLongs: false },
          )
        : null;
      if (
        previous?.state === "ready" &&
        (request.minAsOfMs === undefined ||
          previous.asOfMs >= request.minAsOfMs)
      )
        return { job: previous, previous: null };
      if (head.activeJobId) {
        const active = await collections.reportJobs.findOne(
          { _id: head.activeJobId, queryHash },
          { session, promoteLongs: false },
        );
        if (!active) throw new DatabasePluginInputError("invalid-result");
        return { job: active, previous };
      }
      const job: MongoInsightsReportJob = {
        _id: randomUUID(),
        queryHash,
        query: request.query,
        state: "queued",
        phase: "source",
        sourceId: state.sourceId,
        sourceGeneration: mongoInsightsProjectionSourceGeneration(state),
        projectionUpper: state.nextProjectionSequence,
        asOfMs: Date.now(),
        completedAtMs: null,
        afterProjectionSequence: Long.ZERO,
        afterInstallKey: null,
        afterBucketId: null,
        orderSection: 0,
        orderAfterValue: null,
        orderAfterKey: null,
        orderAfterId: null,
        nextOrdinal: Long.ZERO,
        orderTotals: [],
        publishIndex: 0,
        publishBundleSummaries: [],
        publication: null,
        leaseOwner: null,
        leaseEpoch: 0,
        leaseExpiresAt: null,
      };
      await collections.reportJobs.insertOne(job, { session });
      const saved = await collections.reportHeads.updateOne(
        { _id: queryHash, activeJobId: null },
        { $set: { activeJobId: job._id } },
        { session },
      );
      if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
      return { job, previous };
    }, transactionOptions),
  );
};

const countId = (
  jobId: string,
  section: MongoInsightsReportCount["section"],
  metric: MongoInsightsReportCount["metric"],
  label: string,
  bucketStartMs: number,
): string =>
  mongoInsightsDigest([jobId, section, metric, label, bucketStartMs]);

const labelOrderKey = (label: string): string => {
  let key = "";
  for (let index = 0; index < label.length; index += 1)
    key += label.charCodeAt(index).toString(16).padStart(4, "0");
  return key;
};

const incrementCount = async (
  collections: MongoInsightsModelCollections,
  jobId: string,
  section: MongoInsightsReportCount["section"],
  metric: MongoInsightsReportCount["metric"],
  label: string,
  bucketStartMs: number,
  session: ClientSession,
): Promise<void> => {
  const id = countId(jobId, section, metric, label, bucketStartMs);
  const expectedLabelOrderKey = labelOrderKey(label);
  const expectedLabelCursorKey = `${expectedLabelOrderKey}!${id}`;
  const stored = await collections.reportCounts.findOneAndUpdate(
    { _id: id, value: { $lt: Number.MAX_SAFE_INTEGER } },
    {
      $setOnInsert: {
        jobId,
        section,
        metric,
        label,
        labelOrderKey: expectedLabelOrderKey,
        labelCursorKey: expectedLabelCursorKey,
        bucketStartMs,
      },
      $inc: { value: 1 },
    },
    { session, upsert: true, returnDocument: "after" },
  );
  if (
    !stored ||
    stored.jobId !== jobId ||
    stored.section !== section ||
    stored.metric !== metric ||
    stored.label !== label ||
    stored.labelOrderKey !== expectedLabelOrderKey ||
    stored.labelCursorKey !== expectedLabelCursorKey ||
    stored.bucketStartMs !== bucketStartMs ||
    !Number.isSafeInteger(stored.value) ||
    stored.value < 1
  )
    throw new DatabasePluginInputError("invalid-result");
};

const addMember = async (
  collections: MongoInsightsModelCollections,
  input: {
    readonly jobId: string;
    readonly section: "summary" | "movementSeries" | "movementCohorts";
    readonly metric: "installed" | "recovered";
    readonly label: string;
    readonly bucketStartMs: number;
    readonly installKey: string;
  },
  session: ClientSession,
): Promise<void> => {
  const id = mongoInsightsDigest([
    input.jobId,
    input.section,
    input.metric,
    input.label,
    input.bucketStartMs,
    input.installKey,
  ]);
  const result = await collections.reportMembers.updateOne(
    { _id: id },
    { $setOnInsert: input },
    { session, upsert: true },
  );
  if (result.upsertedCount === 1)
    await incrementCount(
      collections,
      input.jobId,
      input.section,
      input.metric,
      input.label,
      input.bucketStartMs,
      session,
    );
};

const newer = (left: BundleEventRow, right: BundleEventRow): boolean =>
  left.received_at_ms > right.received_at_ms ||
  (left.received_at_ms === right.received_at_ms && left.id > right.id);

const saveLatest = async (
  collections: MongoInsightsModelCollections,
  job: MongoInsightsReportJob,
  event: BundleEventRow,
  session: ClientSession,
): Promise<void> => {
  const installKey = mongoInsightsInstallationKey(event.install_id);
  const id = mongoInsightsDigest([job._id, installKey]);
  const existing = await collections.reportLatest.findOne(
    { _id: id },
    { session },
  );
  if (existing) {
    if (
      existing.installKey !== installKey ||
      existing.installId !== event.install_id
    )
      throw new DatabasePluginInputError("invalid-result");
    if (!newer(event, existing.event)) return;
    await collections.reportLatest.updateOne(
      { _id: id, "event.id": existing.event.id },
      { $set: { event } },
      { session },
    );
    return;
  }
  await collections.reportLatest.insertOne(
    { _id: id, jobId: job._id, installKey, installId: event.install_id, event },
    { session },
  );
};

const saveBucket = async (
  collections: MongoInsightsModelCollections,
  job: MongoInsightsReportJob,
  event: BundleEventRow,
  bucketStartMs: number,
  session: ClientSession,
): Promise<void> => {
  const installKey = mongoInsightsInstallationKey(event.install_id);
  const id = mongoInsightsDigest([job._id, installKey, bucketStartMs]);
  const existing = await collections.reportBuckets.findOne(
    { _id: id },
    { session },
  );
  if (existing) {
    if (
      existing.installKey !== installKey ||
      existing.installId !== event.install_id ||
      existing.bucketStartMs !== bucketStartMs
    )
      throw new DatabasePluginInputError("invalid-result");
    if (!newer(event, existing.event)) return;
    await collections.reportBuckets.updateOne(
      { _id: id, "event.id": existing.event.id },
      { $set: { event } },
      { session },
    );
    return;
  }
  await collections.reportBuckets.insertOne(
    {
      _id: id,
      jobId: job._id,
      installKey,
      installId: event.install_id,
      bucketStartMs,
      event,
    },
    { session },
  );
};

const processEvent = async (
  collections: MongoInsightsModelCollections,
  job: MongoInsightsReportJob,
  event: BundleEventRow,
  session: ClientSession,
): Promise<void> => {
  const projection = createInsightsReportProjection(
    job.query,
    job.asOfMs,
  ).project(event);
  if (projection === null) return;
  if (projection.kind === "movement") {
    const installKey = mongoInsightsInstallationKey(projection.installId);
    await addMember(
      collections,
      {
        jobId: job._id,
        section: "summary",
        metric: projection.metric,
        label: projection.bundleId,
        bucketStartMs: -1,
        installKey,
      },
      session,
    );
    if (job.query.kind === "bundleDetail") {
      await addMember(
        collections,
        {
          jobId: job._id,
          section: "movementSeries",
          metric: projection.metric,
          label: projection.bundleId,
          bucketStartMs: projection.bucketStartMs,
          installKey,
        },
        session,
      );
      await addMember(
        collections,
        {
          jobId: job._id,
          section: "movementCohorts",
          metric: projection.metric,
          label: projection.cohort,
          bucketStartMs: -1,
          installKey,
        },
        session,
      );
    }
    return;
  }
  await saveLatest(collections, job, projection.event, session);
  if (projection.bucketStartMs !== null)
    await saveBucket(
      collections,
      job,
      projection.event,
      projection.bucketStartMs,
      session,
    );
};

const nextAfterSource = (
  job: MongoInsightsReportJob,
): MongoInsightsReportJob["phase"] =>
  job.query.kind === "installationOverview" ||
  job.query.kind === "activeOverview"
    ? "installations"
    : job.query.kind === "bundleDetail"
      ? "order"
      : "publish";

type ReportJobLease = {
  readonly owner: string;
  readonly epoch: number;
};

const reportLeaseFilter = (jobId: string, lease: ReportJobLease) => ({
  _id: jobId,
  leaseOwner: lease.owner,
  leaseEpoch: lease.epoch,
  $expr: { $gt: ["$leaseExpiresAt", "$$NOW"] },
});

const stepSource = async (
  collections: MongoInsightsModelCollections,
  job: MongoInsightsReportJob,
  limit: number,
  lease: ReportJobLease,
  session: ClientSession,
  usage?: MongoInsightsStepUsage,
): Promise<void> => {
  const rows = await collections.projectionEvents
    .find(
      {
        projectionSequence: {
          $gt: job.afterProjectionSequence,
          $lte: job.projectionUpper,
        },
      },
      { session, promoteLongs: false, singleBatch: true },
    )
    .hint("insights_projection_sequence_idx")
    .sort({ projectionSequence: 1 })
    .limit(limit)
    .batchSize(limit)
    .toArray();
  if (usage !== undefined) usage.items += rows.length;
  for (const row of rows) {
    assertMongoInsightsProjectionEvent(row);
    await processEvent(collections, job, row.event, session);
  }
  const last = rows.at(-1);
  const saved = await collections.reportJobs.updateOne(
    {
      ...reportLeaseFilter(job._id, lease),
      state: { $in: ["queued", "preparing"] },
      phase: "source",
    },
    {
      $set: {
        state: "preparing",
        afterProjectionSequence:
          last?.projectionSequence ?? job.afterProjectionSequence,
        phase: rows.length === limit ? "source" : nextAfterSource(job),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    },
    { session },
  );
  if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
};

const stepInstallations = async (
  collections: MongoInsightsModelCollections,
  job: MongoInsightsReportJob,
  limit: number,
  lease: ReportJobLease,
  session: ClientSession,
  usage?: MongoInsightsStepUsage,
): Promise<void> => {
  const rows = await collections.reportLatest
    .find(
      {
        jobId: job._id,
        ...(job.afterInstallKey === null
          ? {}
          : { installKey: { $gt: job.afterInstallKey } }),
      },
      { session, singleBatch: true },
    )
    .hint("insights_report_latest_idx")
    .sort({ installKey: 1 })
    .limit(limit)
    .batchSize(limit)
    .toArray();
  if (usage !== undefined) usage.items += rows.length;
  for (const row of rows) {
    if (
      mongoInsightsInstallationKey(row.installId) !== row.installKey ||
      row.event.install_id !== row.installId
    )
      throw new DatabasePluginInputError("invalid-result");
    if (
      job.query.kind === "activeOverview" &&
      job.query.userId !== undefined &&
      row.event.user_id !== job.query.userId
    )
      continue;
    await incrementCount(collections, job._id, "summary", "", "", -1, session);
    await incrementCount(
      collections,
      job._id,
      "bundleDistribution",
      "",
      row.event.to_bundle_id,
      -1,
      session,
    );
  }
  const last = rows.at(-1);
  const saved = await collections.reportJobs.updateOne(
    { ...reportLeaseFilter(job._id, lease), phase: "installations" },
    {
      $set: {
        afterInstallKey: last?.installKey ?? job.afterInstallKey,
        phase:
          rows.length === limit
            ? "installations"
            : job.query.kind === "activeOverview"
              ? "buckets"
              : "order",
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    },
    { session },
  );
  if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
};

const stepBuckets = async (
  collections: MongoInsightsModelCollections,
  job: MongoInsightsReportJob,
  limit: number,
  lease: ReportJobLease,
  session: ClientSession,
  usage?: MongoInsightsStepUsage,
): Promise<void> => {
  const rows = await collections.reportBuckets
    .find(
      {
        jobId: job._id,
        ...(job.afterBucketId === null
          ? {}
          : { _id: { $gt: job.afterBucketId } }),
      },
      { session, singleBatch: true },
    )
    .hint("_id_")
    .sort({ _id: 1 })
    .limit(limit)
    .batchSize(limit)
    .toArray();
  if (usage !== undefined) usage.items += rows.length;
  for (const row of rows) {
    if (job.query.kind === "activeOverview" && job.query.userId !== undefined) {
      const latest = await collections.reportLatest.findOne(
        { _id: mongoInsightsDigest([job._id, row.installKey]) },
        { session },
      );
      if (
        !latest ||
        latest.installKey !== row.installKey ||
        latest.installId !== row.installId
      )
        throw new DatabasePluginInputError("invalid-result");
      if (latest.event.user_id !== job.query.userId) continue;
    }
    await incrementCount(
      collections,
      job._id,
      "activeSeries",
      "",
      "",
      row.bucketStartMs,
      session,
    );
    await incrementCount(
      collections,
      job._id,
      "activeBundleSeries",
      "",
      row.event.to_bundle_id,
      row.bucketStartMs,
      session,
    );
    await incrementCount(
      collections,
      job._id,
      "activeBundleTotals",
      "",
      row.event.to_bundle_id,
      -1,
      session,
    );
  }
  const last = rows.at(-1);
  const saved = await collections.reportJobs.updateOne(
    { ...reportLeaseFilter(job._id, lease), phase: "buckets" },
    {
      $set: {
        afterBucketId: last?._id ?? job.afterBucketId,
        phase: rows.length === limit ? "buckets" : "order",
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    },
    { session },
  );
  if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
};

type OrderSection = {
  readonly section:
    | "movementCohorts"
    | "bundleDistribution"
    | "activeBundleTotals";
  readonly metric: "" | "installed" | "recovered";
  readonly byValue: boolean;
};

const orderSections = (query: InsightsReportQuery): readonly OrderSection[] => {
  switch (query.kind) {
    case "bundleSummaries":
      return [];
    case "bundleDetail":
      return [
        {
          section: "movementCohorts",
          metric: "installed",
          byValue: false,
        },
        {
          section: "movementCohorts",
          metric: "recovered",
          byValue: false,
        },
      ];
    case "installationOverview":
      return [{ section: "bundleDistribution", metric: "", byValue: true }];
    case "activeOverview":
      return [
        { section: "bundleDistribution", metric: "", byValue: true },
        { section: "activeBundleTotals", metric: "", byValue: true },
      ];
  }
};

const stepOrder = async (
  collections: MongoInsightsModelCollections,
  job: MongoInsightsReportJob,
  limit: number,
  lease: ReportJobLease,
  session: ClientSession,
  usage?: MongoInsightsStepUsage,
): Promise<void> => {
  const sections = orderSections(job.query);
  const section = sections[job.orderSection];
  if (!section) {
    const saved = await collections.reportJobs.updateOne(
      { ...reportLeaseFilter(job._id, lease), phase: "order" },
      {
        $set: {
          phase: "publish",
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      },
      { session },
    );
    if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
    return;
  }
  const after =
    job.orderAfterKey === null
      ? {}
      : section.byValue
        ? {
            $or: [
              { value: { $lt: job.orderAfterValue! } },
              {
                value: job.orderAfterValue!,
                labelOrderKey: { $gt: job.orderAfterKey },
              },
              {
                value: job.orderAfterValue!,
                labelOrderKey: job.orderAfterKey,
                _id: { $gt: job.orderAfterId! },
              },
            ],
          }
        : {
            labelCursorKey: { $gt: job.orderAfterKey },
          };
  const rows = await collections.reportCounts
    .find(
      {
        jobId: job._id,
        section: section.section,
        metric: section.metric,
        bucketStartMs: -1,
        ...after,
      },
      { session, singleBatch: true },
    )
    .hint(
      section.byValue
        ? "insights_report_count_value_order_idx"
        : "insights_report_count_label_order_idx",
    )
    .sort(
      section.byValue
        ? { value: -1, labelOrderKey: 1, _id: 1 }
        : { labelCursorKey: 1 },
    )
    .limit(limit)
    .batchSize(limit)
    .toArray();
  if (usage !== undefined) usage.items += rows.length;
  let ordinal = job.nextOrdinal;
  for (const row of rows) {
    await collections.reportOrder.insertOne(
      {
        _id: mongoInsightsDigest([
          job._id,
          section.section,
          section.metric,
          ordinal.toString(),
        ]),
        jobId: job._id,
        section: section.section,
        metric: section.metric,
        ordinal,
        label: row.label,
        labelOrderKey: row.labelOrderKey,
        value: row.value,
      },
      { session },
    );
    ordinal = ordinal.add(Long.ONE);
  }
  const last = rows.at(-1);
  if (rows.length === limit && last) {
    const saved = await collections.reportJobs.updateOne(
      {
        ...reportLeaseFilter(job._id, lease),
        phase: "order",
        orderSection: job.orderSection,
      },
      {
        $set: {
          orderAfterValue: section.byValue ? last.value : null,
          orderAfterKey: section.byValue
            ? last.labelOrderKey
            : last.labelCursorKey,
          orderAfterId: section.byValue ? last._id : null,
          nextOrdinal: ordinal,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      },
      { session },
    );
    if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
    return;
  }
  const saved = await collections.reportJobs.updateOne(
    {
      ...reportLeaseFilter(job._id, lease),
      phase: "order",
      orderSection: job.orderSection,
    },
    {
      $set: {
        orderSection: job.orderSection + 1,
        orderAfterValue: null,
        orderAfterKey: null,
        orderAfterId: null,
        nextOrdinal: Long.ZERO,
        [`orderTotals.${job.orderSection}`]: ordinal.toNumber(),
        phase: job.orderSection + 1 >= sections.length ? "publish" : "order",
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    },
    { session },
  );
  if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
};

const readCount = async (
  collections: MongoInsightsModelCollections,
  jobId: string,
  section: MongoInsightsReportCount["section"],
  metric: MongoInsightsReportCount["metric"],
  label: string,
  bucketStartMs: number,
  session?: ClientSession,
): Promise<number> => {
  const id = countId(jobId, section, metric, label, bucketStartMs);
  const row = await collections.reportCounts.findOne({ _id: id }, { session });
  if (row === null) return 0;
  const orderKey = labelOrderKey(label);
  if (
    row.jobId !== jobId ||
    row.section !== section ||
    row.metric !== metric ||
    row.label !== label ||
    row.labelOrderKey !== orderKey ||
    row.labelCursorKey !== `${orderKey}!${id}` ||
    row.bucketStartMs !== bucketStartMs ||
    !Number.isSafeInteger(row.value) ||
    row.value < 0
  )
    throw new DatabasePluginInputError("invalid-result");
  return row.value;
};

const createPublication = async (
  collections: MongoInsightsModelCollections,
  job: MongoInsightsReportJob,
  completedAtMs: number,
  session: ClientSession,
): Promise<InsightsReportPublication> => {
  const base: InsightsPublication = {
    id: job._id,
    asOfMs: job.asOfMs,
    completedAtMs,
    sourceGeneration: job.sourceGeneration,
    accuracy: "exact",
  };
  switch (job.query.kind) {
    case "bundleSummaries": {
      const bundleIds = job.query.bundleIds;
      if (
        job.publishIndex !== bundleIds.length ||
        job.publishBundleSummaries.length !== bundleIds.length ||
        job.publishBundleSummaries.some(
          (row, index) => row.bundleId !== bundleIds[index],
        )
      )
        throw new DatabasePluginInputError("invalid-result");
      return {
        ...base,
        kind: job.query.kind,
        summary: job.publishBundleSummaries,
      };
    }
    case "bundleDetail":
      return {
        ...base,
        kind: job.query.kind,
        summary: {
          installed: await readCount(
            collections,
            job._id,
            "summary",
            "installed",
            job.query.bundleId,
            -1,
            session,
          ),
          recovered: await readCount(
            collections,
            job._id,
            "summary",
            "recovered",
            job.query.bundleId,
            -1,
            session,
          ),
        },
      };
    case "installationOverview":
      return {
        ...base,
        kind: job.query.kind,
        summary: {
          trackedInstallations: await readCount(
            collections,
            job._id,
            "summary",
            "",
            "",
            -1,
            session,
          ),
        },
      };
    case "activeOverview":
      return {
        ...base,
        kind: job.query.kind,
        summary: {
          activeInstallations: await readCount(
            collections,
            job._id,
            "summary",
            "",
            "",
            -1,
            session,
          ),
        },
      };
  }
};

const publish = async (
  collections: MongoInsightsModelCollections,
  job: MongoInsightsReportJob,
  limit: number,
  lease: ReportJobLease,
  session: ClientSession,
  usage?: MongoInsightsStepUsage,
): Promise<boolean> => {
  if (
    job.query.kind === "bundleSummaries" &&
    job.publishIndex < job.query.bundleIds.length
  ) {
    const bundleIds = job.query.bundleIds.slice(
      job.publishIndex,
      job.publishIndex + limit,
    );
    if (usage !== undefined) usage.items += bundleIds.length;
    const summary = [];
    for (const bundleId of bundleIds) {
      summary.push({
        bundleId,
        installed: await readCount(
          collections,
          job._id,
          "summary",
          "installed",
          bundleId,
          -1,
          session,
        ),
        recovered: await readCount(
          collections,
          job._id,
          "summary",
          "recovered",
          bundleId,
          -1,
          session,
        ),
      });
    }
    const saved = await collections.reportJobs.updateOne(
      {
        ...reportLeaseFilter(job._id, lease),
        phase: "publish",
        publishIndex: job.publishIndex,
      },
      {
        $set: {
          state: "preparing",
          publishIndex: job.publishIndex + bundleIds.length,
          publishBundleSummaries: [...job.publishBundleSummaries, ...summary],
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      },
      { session },
    );
    if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
    return false;
  }
  const completedAtMs = Date.now();
  if (usage !== undefined) usage.items += 1;
  const publication = await createPublication(
    collections,
    job,
    completedAtMs,
    session,
  );
  const saved = await collections.reportJobs.updateOne(
    {
      ...reportLeaseFilter(job._id, lease),
      phase: "publish",
      state: { $in: ["queued", "preparing"] },
    },
    {
      $set: {
        state: "ready",
        completedAtMs,
        publication,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    },
    { session },
  );
  if (saved.matchedCount !== 1)
    throw new DatabasePluginInputError("invalid-result");
  await collections.reportHeads.updateOne(
    { _id: job.queryHash, activeJobId: job._id },
    { $set: { activeJobId: null, publicationJobId: job._id } },
    { session },
  );
  return true;
};

export const stepMongoInsightsReport = async (
  client: MongoClient,
  jobId: string,
  limit: number,
  usage?: MongoInsightsStepUsage,
): Promise<"progress" | "published" | "failed"> => {
  const collections = createMongoInsightsModelCollections(client, usage);
  const owner = randomUUID();
  const claimed = await collections.reportJobs.findOneAndUpdate(
    {
      _id: jobId,
      state: { $in: ["queued", "preparing"] },
      $expr: {
        $or: [
          { $eq: ["$leaseOwner", null] },
          { $lte: ["$leaseExpiresAt", "$$NOW"] },
        ],
      },
    },
    [
      {
        $set: {
          leaseOwner: owner,
          leaseExpiresAt: {
            $dateAdd: {
              startDate: "$$NOW",
              unit: "millisecond",
              amount: 120_000,
            },
          },
          leaseEpoch: { $add: ["$leaseEpoch", 1] },
        },
      },
    ],
    { returnDocument: "after", promoteLongs: false },
  );
  if (claimed === null) {
    const terminal = await collections.reportJobs.findOne(
      { _id: jobId },
      { projection: { state: 1 } },
    );
    return terminal?.state === "ready"
      ? "published"
      : terminal?.state === "failed"
        ? "failed"
        : "progress";
  }
  const lease = { owner, epoch: claimed.leaseEpoch };
  try {
    return await client.withSession((session) =>
      session.withTransaction(async () => {
        const job = await collections.reportJobs.findOne(
          reportLeaseFilter(jobId, lease),
          { session, promoteLongs: false },
        );
        if (!job) throw new InsightsQueryNotReadyError();
        if (job.state === "ready") return "published" as const;
        if (job.state === "failed") return "failed" as const;
        switch (job.phase) {
          case "source":
            await stepSource(collections, job, limit, lease, session, usage);
            break;
          case "installations":
            await stepInstallations(
              collections,
              job,
              limit,
              lease,
              session,
              usage,
            );
            break;
          case "buckets":
            await stepBuckets(collections, job, limit, lease, session, usage);
            break;
          case "order":
            await stepOrder(collections, job, limit, lease, session, usage);
            break;
          case "publish":
            return (await publish(
              collections,
              job,
              limit,
              lease,
              session,
              usage,
            ))
              ? ("published" as const)
              : ("progress" as const);
        }
        return "progress" as const;
      }, transactionOptions),
    );
  } catch (error) {
    const corruption =
      error instanceof DatabasePluginInputError &&
      error.code === "invalid-result";
    await collections.reportJobs.updateOne(
      {
        ...reportLeaseFilter(jobId, lease),
        state: { $in: ["queued", "preparing"] },
      },
      {
        $set: corruption
          ? {
              state: "failed",
              completedAtMs: Date.now(),
              leaseOwner: null,
              leaseExpiresAt: null,
            }
          : { leaseOwner: null, leaseExpiresAt: null },
      },
    );
    throw error;
  }
};

const reportResult = (
  job: MongoInsightsReportJob,
  state: "ready" | "stale",
  refreshId?: string,
): InsightsReportResult => {
  assertReadyReportJob(job);
  assertMongoInsightsProjectionSourceGeneration(
    job.sourceGeneration,
    job.sourceId,
    job.projectionUpper,
  );
  return state === "stale"
    ? {
        state,
        versions: versions(job),
        data: job.publication,
        refresh: { id: refreshId! },
      }
    : { state, versions: versions(job), data: job.publication };
};

export const getMongoInsightsReport = async (
  client: MongoClient,
  input: InsightsReportInput,
): Promise<InsightsReportResult> => {
  let readyJob: MongoInsightsReportJob | null = null;
  try {
    const reservation = await reserveReport(client, input);
    let result: InsightsReportResult;
    if (reservation.job.state === "failed") {
      result = {
        state: "failed",
        versions: versions(reservation.job),
        error: { code: "migration-poison", jobId: reservation.job._id },
      };
    } else if (reservation.previous?.state === "ready") {
      readyJob = reservation.previous;
      result = reportResult(reservation.previous, "stale", reservation.job._id);
    } else if (reservation.job.state === "ready") {
      readyJob = reservation.job;
      result = reportResult(reservation.job, "ready");
    } else {
      result = {
        state: "preparing",
        versions: versions(reservation.job),
        job: { id: reservation.job._id },
      };
    }
    assertInsightsReportResultContract(result);
    return result;
  } catch (error) {
    if (
      readyJob !== null &&
      error instanceof DatabasePluginInputError &&
      error.code === "invalid-result"
    ) {
      await createMongoInsightsModelCollections(client).reportJobs.updateOne(
        { _id: readyJob._id, state: "ready" },
        { $set: { state: "failed" } },
      );
      const result = {
        state: "failed" as const,
        versions: versions(readyJob),
        error: { code: "storage-corruption" as const },
      };
      assertInsightsReportResultContract(result);
      return result;
    }
    if (!(error instanceof InsightsQueryNotReadyError)) throw error;
    return {
      state: "failed",
      versions: failedVersions(),
      error: { code: "source-not-ready" },
    };
  }
};

const requireSection = (
  query: InsightsReportQuery,
  input: ReturnType<typeof readInsightsReportPageQuery>["input"],
): void => {
  if (
    ((input.section === "movementSeries" ||
      input.section === "movementCohorts") &&
      query.kind !== "bundleDetail") ||
    (input.section === "bundleDistribution" &&
      query.kind !== "installationOverview" &&
      query.kind !== "activeOverview") ||
    ((input.section === "activeSeries" ||
      input.section === "activeBundleSeries") &&
      query.kind !== "activeOverview")
  )
    throw new DatabasePluginInputError("invalid-query");
};

const bounds = (
  input: InsightsReportPageInput,
  start: bigint,
  total: bigint,
  databaseNamespace: string,
): { readonly size: number; readonly nextCursor: string | null } => {
  const available = total > start ? total - start : 0n;
  const size = Number(
    available < BigInt(input.limit) ? available : BigInt(input.limit),
  );
  const next = start + BigInt(size);
  return {
    size,
    nextCursor:
      next < total
        ? createInsightsReportPageCursor(
            input,
            next.toString(),
            databaseNamespace,
          )
        : null,
  };
};

const orderTotal = (
  job: MongoInsightsReportJob,
  section: MongoInsightsReportOrder["section"],
  metric: MongoInsightsReportOrder["metric"],
): number => {
  const index = orderSections(job.query).findIndex(
    (item) => item.section === section && item.metric === metric,
  );
  const total = index < 0 ? undefined : job.orderTotals[index];
  if (!Number.isSafeInteger(total) || total! < 0)
    throw new DatabasePluginInputError("invalid-result");
  return total!;
};

const readOrder = async (
  collections: MongoInsightsModelCollections,
  job: MongoInsightsReportJob,
  section: MongoInsightsReportOrder["section"],
  metric: MongoInsightsReportOrder["metric"],
  start: bigint,
  size: number,
): Promise<readonly MongoInsightsReportOrder[]> => {
  if (size === 0) return [];
  const rows = await collections.reportOrder
    .find(
      {
        jobId: job._id,
        section,
        metric,
        ordinal: {
          $gte: Long.fromBigInt(start),
          $lt: Long.fromBigInt(start + BigInt(size)),
        },
      },
      { promoteLongs: false, singleBatch: true },
    )
    .hint("insights_report_order_idx")
    .sort({ ordinal: 1 })
    .limit(size)
    .batchSize(size)
    .toArray();
  if (
    rows.length !== size ||
    rows.some(
      (row, index) =>
        row.jobId !== job._id ||
        row.section !== section ||
        row.metric !== metric ||
        !Long.isLong(row.ordinal) ||
        row.ordinal.toBigInt() !== start + BigInt(index) ||
        row.labelOrderKey !== labelOrderKey(row.label) ||
        !Number.isSafeInteger(row.value) ||
        row.value < 0,
    )
  )
    throw new DatabasePluginInputError("invalid-result");
  return rows;
};

const readCounts = async (
  collections: MongoInsightsModelCollections,
  job: MongoInsightsReportJob,
  identities: readonly {
    readonly section: MongoInsightsReportCount["section"];
    readonly metric: MongoInsightsReportCount["metric"];
    readonly label: string;
    readonly bucketStartMs: number;
  }[],
): Promise<readonly number[]> => {
  if (identities.length === 0) return [];
  const ids = identities.map((identity) =>
    countId(
      job._id,
      identity.section,
      identity.metric,
      identity.label,
      identity.bucketStartMs,
    ),
  );
  const rows = await collections.reportCounts
    .find({ _id: { $in: ids } }, { singleBatch: true })
    .limit(ids.length)
    .batchSize(ids.length)
    .toArray();
  if (
    rows.some((row) => {
      const index = ids.indexOf(row._id);
      const identity = identities[index];
      return (
        index < 0 ||
        identity === undefined ||
        row.jobId !== job._id ||
        row.section !== identity.section ||
        row.metric !== identity.metric ||
        row.label !== identity.label ||
        row.labelOrderKey !== labelOrderKey(row.label) ||
        row.labelCursorKey !== `${row.labelOrderKey}!${row._id}` ||
        row.bucketStartMs !== identity.bucketStartMs ||
        !Number.isSafeInteger(row.value) ||
        row.value < 0
      );
    })
  )
    throw new DatabasePluginInputError("invalid-result");
  const values = new Map(rows.map((row) => [row._id, row.value]));
  return ids.map((id) => values.get(id) ?? 0);
};

function assertReadyReportJob(
  job: MongoInsightsReportJob,
): asserts job is MongoInsightsReportJob & {
  readonly state: "ready";
  readonly completedAtMs: number;
  readonly publication: InsightsReportPublication;
} {
  let semanticKey: string;
  let canonicalQuery: InsightsReportQuery;
  try {
    const request = readInsightsReportQuery({ query: job.query });
    semanticKey = request.semanticKey;
    canonicalQuery = request.query;
    assertInsightsReportResultContract({
      state: "ready",
      versions: versions(job),
      data: job.publication,
    });
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  if (
    job.state !== "ready" ||
    job.publication === null ||
    job.phase !== "publish" ||
    job.completedAtMs === null ||
    job.orderTotals.length !== orderSections(job.query).length ||
    job.orderTotals.some(
      (total) => !Number.isSafeInteger(total) || total < 0,
    ) ||
    job.publication.id !== job._id ||
    job.publication.asOfMs !== job.asOfMs ||
    job.publication.completedAtMs !== job.completedAtMs ||
    job.publication.sourceGeneration !== job.sourceGeneration ||
    job.publication.accuracy !== "exact" ||
    job.publication.kind !== job.query.kind ||
    JSON.stringify(job.query) !== JSON.stringify(canonicalQuery) ||
    job.queryHash !==
      mongoInsightsDigest([MONGO_INSIGHTS_STORAGE_VERSION, semanticKey])
  )
    throw new DatabasePluginInputError("invalid-result");
  if (
    canonicalQuery.kind === "bundleSummaries" &&
    (job.publication.kind !== "bundleSummaries" ||
      job.publication.summary.length !== canonicalQuery.bundleIds.length ||
      job.publication.summary.some(
        (row, index) => row.bundleId !== canonicalQuery.bundleIds[index],
      ))
  )
    throw new DatabasePluginInputError("invalid-result");
}

const failedReportPage = async (
  collections: MongoInsightsModelCollections,
  job: MongoInsightsReportJob,
): Promise<InsightsReportPage> => {
  await collections.reportJobs.updateOne(
    { _id: job._id, state: "ready" },
    { $set: { state: "failed" } },
  );
  const result = {
    state: "failed" as const,
    versions: versions(job),
    error: { code: "storage-corruption" as const },
  };
  assertInsightsReportPageResultContract(result, 1);
  return result;
};

export const pageMongoInsightsReport = async (
  client: MongoClient,
  input: InsightsReportPageInput,
): Promise<InsightsReportPage> => {
  try {
    input = readInsightsReportPageInput(input);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  const databaseNamespace = client.db().databaseName;
  const parsed = readInsightsReportPageQuery(input, databaseNamespace);
  const collections = createMongoInsightsModelCollections(client);
  const state = await readReadyState(collections);
  const job = await collections.reportJobs.findOne(
    { _id: input.publicationId },
    { promoteLongs: false },
  );
  if (!job || job.state === "queued" || job.state === "preparing")
    return { state: "expired", publicationId: input.publicationId };
  if (job.state === "failed")
    return {
      state: "failed",
      versions: versions(job),
      error: { code: "storage-corruption" },
    };
  try {
    assertReadyReportJob(job);
    assertMongoInsightsProjectionSourceGeneration(
      job.sourceGeneration,
      job.sourceId,
      job.projectionUpper,
    );
    if (job.sourceId !== state.sourceId)
      throw new DatabasePluginInputError("invalid-result");
  } catch (error) {
    if (
      error instanceof DatabasePluginInputError &&
      error.code === "invalid-query"
    )
      return failedReportPage(collections, job);
    if (
      error instanceof DatabasePluginInputError &&
      error.code === "invalid-result"
    )
      return failedReportPage(collections, job);
    throw error;
  }
  requireSection(job.query, parsed.input);
  const projection = createInsightsReportProjection(job.query, job.asOfMs);
  const start = BigInt(parsed.nextOrdinal);
  const consistency = {
    kind: "snapshot" as const,
    cutoff: {
      kind: "publication" as const,
      publication: {
        id: job.publication.id,
        asOfMs: job.publication.asOfMs,
        completedAtMs: job.publication.completedAtMs,
        sourceGeneration: job.publication.sourceGeneration,
        accuracy: job.publication.accuracy,
      },
    },
  };
  let data: InsightsPublishedReportPageData;
  try {
    switch (parsed.input.section) {
      case "movementCohorts":
      case "bundleDistribution": {
        const metric =
          parsed.input.section === "movementCohorts" ? parsed.input.metric : "";
        const total = BigInt(orderTotal(job, parsed.input.section, metric));
        const page = bounds(input, start, total, databaseNamespace);
        const rows = await readOrder(
          collections,
          job,
          parsed.input.section,
          metric,
          start,
          page.size,
        );
        const common = {
          nextCursor: page.nextCursor,
          hasNext: page.nextCursor !== null,
          consistency,
          total: {
            state: "exact" as const,
            value: Number(total),
            sourceGeneration: job.sourceGeneration,
          },
        };
        data = (
          parsed.input.section === "movementCohorts"
            ? {
                ...common,
                section: parsed.input.section,
                metric: parsed.input.metric,
                data: rows.map((row) => ({
                  cohort: row.label,
                  value: row.value,
                })),
              }
            : {
                ...common,
                section: parsed.input.section,
                data: rows.map((row) => ({
                  bundleId: row.label,
                  installations: row.value,
                })),
              }
        ) as InsightsPublishedReportPageData;
        break;
      }
      case "movementSeries":
      case "activeSeries": {
        let first = projection.firstBucketMs;
        if (first === null) {
          const oldest = await collections.reportCounts
            .find(
              {
                jobId: job._id,
                section: "movementSeries",
                metric:
                  parsed.input.section === "movementSeries"
                    ? parsed.input.metric
                    : "",
              },
              { projection: { bucketStartMs: 1 }, singleBatch: true },
            )
            .sort({ bucketStartMs: 1 })
            .limit(1)
            .toArray();
          first = oldest[0]?.bucketStartMs ?? projection.lastBucketMs;
        }
        const total =
          first > projection.lastBucketMs
            ? 0n
            : BigInt(
                Math.floor(
                  (projection.lastBucketMs - first) / projection.bucketSizeMs,
                ) + 1,
              );
        const page = bounds(input, start, total, databaseNamespace);
        const buckets = Array.from({ length: page.size }, (_, index) =>
          Number(
            BigInt(first!) +
              (start + BigInt(index)) * BigInt(projection.bucketSizeMs),
          ),
        );
        const values = await readCounts(
          collections,
          job,
          buckets.map((bucketStartMs) => ({
            section: parsed.input.section,
            metric:
              parsed.input.section === "movementSeries"
                ? parsed.input.metric
                : "",
            label:
              parsed.input.section === "movementSeries" &&
              job.query.kind === "bundleDetail"
                ? job.query.bundleId
                : "",
            bucketStartMs,
          })),
        );
        const common = {
          data: buckets.map((bucketStartMs, index) => ({
            bucketStartMs,
            value: values[index]!,
          })),
          nextCursor: page.nextCursor,
          hasNext: page.nextCursor !== null,
          consistency,
          total: {
            state: "exact" as const,
            value: Number(total),
            sourceGeneration: job.sourceGeneration,
          },
        };
        data = (
          parsed.input.section === "movementSeries"
            ? {
                ...common,
                section: parsed.input.section,
                metric: parsed.input.metric,
              }
            : { ...common, section: parsed.input.section }
        ) as InsightsPublishedReportPageData;
        break;
      }
      case "activeBundleSeries": {
        const first = projection.firstBucketMs!;
        const bucketCount = BigInt(
          Math.floor(
            (projection.lastBucketMs - first) / projection.bucketSizeMs,
          ) + 1,
        );
        const requested = parsed.input.bundleId;
        let total: bigint;
        let bundles: readonly MongoInsightsReportOrder[];
        if (requested !== undefined) {
          const observations = await readCount(
            collections,
            job._id,
            "activeBundleTotals",
            "",
            requested,
            -1,
          );
          total = observations === 0 ? 0n : bucketCount;
          bundles = [
            {
              _id: "requested",
              jobId: job._id,
              section: "activeBundleTotals",
              metric: "",
              ordinal: Long.ZERO,
              label: requested,
              labelOrderKey: labelOrderKey(requested),
              value: observations,
            },
          ];
        } else {
          const bundleTotal = BigInt(orderTotal(job, "activeBundleTotals", ""));
          total = bundleTotal * bucketCount;
          const page = bounds(input, start, total, databaseNamespace);
          const firstRank = start / bucketCount;
          const lastRank =
            page.size === 0
              ? firstRank
              : (start + BigInt(page.size) - 1n) / bucketCount;
          bundles =
            page.size === 0
              ? []
              : await readOrder(
                  collections,
                  job,
                  "activeBundleTotals",
                  "",
                  firstRank,
                  Number(lastRank - firstRank + 1n),
                );
        }
        const page = bounds(input, start, total, databaseNamespace);
        const baseRank = start / bucketCount;
        const positions = Array.from({ length: page.size }, (_, index) => {
          const ordinal = start + BigInt(index);
          return {
            bundleId:
              requested ??
              bundles[Number(ordinal / bucketCount - baseRank)]!.label,
            bucketStartMs:
              first + Number(ordinal % bucketCount) * projection.bucketSizeMs,
          };
        });
        const values = await readCounts(
          collections,
          job,
          positions.map((position) => ({
            section: "activeBundleSeries",
            metric: "",
            label: position.bundleId,
            bucketStartMs: position.bucketStartMs,
          })),
        );
        data = {
          section: parsed.input.section,
          data: positions.map((position, index) => ({
            ...position,
            value: values[index]!,
          })),
          nextCursor: page.nextCursor,
          hasNext: page.nextCursor !== null,
          consistency,
          total: {
            state: "exact",
            value: Number(total),
            sourceGeneration: job.sourceGeneration,
          },
        };
        break;
      }
    }
    const result = { state: "ready" as const, versions: versions(job), data };
    assertInsightsReportPageResultContract(result, input.limit);
    return result;
  } catch (error) {
    if (
      error instanceof DatabasePluginInputError &&
      error.code === "invalid-result"
    )
      return failedReportPage(collections, job);
    throw error;
  }
};
