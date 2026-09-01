import { randomUUID } from "node:crypto";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsInstallationPage,
  type InsightsInstallationPageInput,
  type InsightsInstallationRow,
  type InsightsLiveInstallationPage,
  type InsightsLiveInstallationPageInput,
  type InsightsPublication,
  type InsightsPublishedInstallationPage,
  type InsightsPublishedInstallationPageInput,
  type InsightsProjectedReadVersions,
  type InsightsReadVersions,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsPageContract,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_PAGE_MAX_BYTES,
  isCanonicalInsightsEventId,
  readInsightsInstallationPageInput,
} from "@hot-updater/plugin-core/internal";
import {
  Long,
  MongoServerError,
  Timestamp,
  type ClientSession,
  type Document,
  type MongoClient,
} from "mongodb";

import {
  createMongoInsightsModelCollections,
  type MongoInsightsAlias,
  MONGO_INSIGHTS_INSTALLATION_COLLECTION,
  type MongoInsightsInstallation,
  type MongoInsightsLiveSnapshot,
  type MongoInsightsModelCollections,
  MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION,
  type MongoInsightsProjectionEvent,
  MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
  type MongoInsightsProjectionState,
  type MongoInsightsSearchDescriptor,
  type MongoInsightsSearchJob,
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

const projectionGeneration = (state: MongoInsightsProjectionState): string =>
  JSON.stringify([
    MONGO_INSIGHTS_STORAGE_VERSION,
    state.sourceId,
    state.nextProjectionSequence.toString(),
  ]);

const versions = (
  source: string,
  projection: string,
): InsightsProjectedReadVersions => ({
  schemaVersion: "1.0.0",
  storageVersion: MONGO_INSIGHTS_STORAGE_VERSION,
  projectionGeneration: projection,
  sourceGeneration: source,
});

const failedVersions = (): InsightsReadVersions => ({
  schemaVersion: "1.0.0",
  storageVersion: MONGO_INSIGHTS_STORAGE_VERSION,
  projectionGeneration: null,
  sourceGeneration: "unavailable",
});

class MongoInsightsSnapshotUnavailableError extends Error {}

const installationRow = (event: BundleEventRow): InsightsInstallationRow => ({
  id: event.id,
  install_id: event.install_id,
  user_id: event.user_id,
  username: event.username,
  to_bundle_id: event.to_bundle_id,
  type: event.type,
  platform: event.platform,
  app_version: event.app_version,
  channel: event.channel,
  cohort: event.cohort,
  received_at_ms: event.received_at_ms,
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

const readLatest = async (
  collections: MongoInsightsModelCollections,
  installKey: string,
  installId: string,
  upper: Long,
  session?: ClientSession,
): Promise<MongoInsightsProjectionEvent> => {
  const row = await collections.projectionEvents.findOne(
    {
      installKey,
      latestVersion: true,
      projectionSequence: { $lte: upper },
    },
    {
      session,
      promoteLongs: false,
      sort: { projectionSequence: -1 },
      hint: "insights_projection_install_latest_idx",
    },
  );
  if (
    !row ||
    row.installId !== installId ||
    mongoInsightsInstallationKey(row.installId) !== installKey ||
    row.event.install_id !== installId
  )
    throw new DatabasePluginInputError("invalid-result");
  assertMongoInsightsProjectionEvent(row);
  return row;
};

const readCursor = (
  input: InsightsInstallationPageInput,
  identity: string,
): string | null => {
  if (input.cursor === undefined) return null;
  try {
    assertInsightsCursorContract(input.cursor);
    const value: unknown = JSON.parse(input.cursor);
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value[0] !== 1 ||
      value[1] !== identity ||
      typeof value[2] !== "string" ||
      !/^[0-9a-f]{64}$/.test(value[2])
    )
      throw null;
    return value[2];
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
};

const makeCursor = (identity: string, key: string): string =>
  JSON.stringify([1, identity, key]);

const readPublishedCursor = (
  input: InsightsPublishedInstallationPageInput,
  queryHash: string,
):
  | { readonly sourceId: string; readonly publicationId: string }
  | undefined => {
  if (input.cursor === undefined) return undefined;
  try {
    assertInsightsCursorContract(input.cursor);
    const outer: unknown = JSON.parse(input.cursor);
    if (
      !Array.isArray(outer) ||
      outer.length !== 3 ||
      outer[0] !== 1 ||
      typeof outer[1] !== "string" ||
      typeof outer[2] !== "string" ||
      !/^[0-9a-f]{64}$/.test(outer[2])
    )
      throw null;
    const identity: unknown = JSON.parse(outer[1]);
    if (
      !Array.isArray(identity) ||
      identity.length !== 4 ||
      identity[0] !== "published" ||
      identity[1] !== queryHash ||
      !isCanonicalInsightsEventId(identity[2]) ||
      typeof identity[3] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        identity[3],
      ) ||
      (input.publicationId !== undefined && input.publicationId !== identity[3])
    )
      throw null;
    return { sourceId: identity[2], publicationId: identity[3] };
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
};

const fitPage = <T>(
  candidates: readonly { readonly key: string; readonly value: T }[],
  requestedLimit: number,
  cursorFor: (key: string) => string,
  build: (rows: readonly T[], nextCursor: string | null) => unknown,
): { readonly rows: readonly T[]; readonly nextCursor: string | null } => {
  const rows: { readonly key: string; readonly value: T }[] = [];
  for (const [index, candidate] of candidates
    .slice(0, requestedLimit)
    .entries()) {
    const trial = [...rows, candidate];
    const cursor =
      index + 1 < candidates.length ? cursorFor(candidate.key) : null;
    if (
      getCanonicalInsightsJsonByteLength(
        build(
          trial.map(({ value }) => value),
          cursor,
        ),
      ) > INSIGHTS_PAGE_MAX_BYTES
    )
      break;
    rows.push(candidate);
  }
  const last = rows.at(-1);
  return {
    rows: rows.map(({ value }) => value),
    nextCursor:
      last && rows.length < candidates.length ? cursorFor(last.key) : null,
  };
};

const validateInput = (
  input: InsightsInstallationPageInput,
): InsightsInstallationPageInput => {
  try {
    return readInsightsInstallationPageInput(input);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
};

const readLiveCursor = (
  input: InsightsLiveInstallationPageInput,
):
  | {
      readonly snapshotId: string;
      readonly identity: string;
      readonly after: string;
    }
  | undefined => {
  if (input.cursor === undefined) return undefined;
  try {
    assertInsightsCursorContract(input.cursor);
    const outer: unknown = JSON.parse(input.cursor);
    if (
      !Array.isArray(outer) ||
      outer.length !== 3 ||
      outer[0] !== 1 ||
      typeof outer[1] !== "string" ||
      typeof outer[2] !== "string" ||
      !/^[0-9a-f]{64}$/.test(outer[2])
    )
      throw null;
    const stored: unknown = JSON.parse(outer[1]);
    const inputKind: unknown = Reflect.get(input as object, "kind");
    const requestedInstallId =
      inputKind === "installationId" ? Reflect.get(input, "installId") : null;
    if (
      !Array.isArray(stored) ||
      stored.length !== 4 ||
      stored[0] !== "live" ||
      stored[1] !== inputKind ||
      stored[2] !== requestedInstallId ||
      typeof stored[3] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        stored[3],
      )
    )
      throw null;
    return { snapshotId: stored[3], identity: outer[1], after: outer[2] };
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
};

type SnapshotPoint = {
  readonly seconds: number;
  readonly increment: number;
};

const snapshotFind = async <TRow>(
  client: MongoClient,
  collection: string,
  input: {
    readonly filter: Document;
    readonly sort?: Document;
    readonly hint?: string;
    readonly limit: number;
    readonly point?: SnapshotPoint;
  },
): Promise<{
  readonly rows: readonly TRow[];
  readonly point: SnapshotPoint;
}> => {
  const result = await client.db().command(
    {
      find: collection,
      filter: input.filter,
      ...(input.sort === undefined ? {} : { sort: input.sort }),
      ...(input.hint === undefined ? {} : { hint: input.hint }),
      limit: input.limit,
      batchSize: input.limit,
      singleBatch: true,
      readConcern: {
        level: "snapshot",
        ...(input.point === undefined
          ? {}
          : {
              atClusterTime: new Timestamp({
                t: input.point.seconds,
                i: input.point.increment,
              }),
            }),
      },
    },
    { promoteLongs: false },
  );
  const cursor = Reflect.get(result, "cursor");
  const batch =
    typeof cursor === "object" && cursor !== null
      ? Reflect.get(cursor, "firstBatch")
      : null;
  const atClusterTime =
    input.point === undefined && typeof cursor === "object" && cursor !== null
      ? Reflect.get(cursor, "atClusterTime")
      : null;
  const point =
    input.point ??
    (atClusterTime instanceof Timestamp
      ? {
          seconds: atClusterTime.getHighBitsUnsigned(),
          increment: atClusterTime.getLowBitsUnsigned(),
        }
      : null);
  if (!Array.isArray(batch) || point === null)
    throw new DatabasePluginInputError("invalid-result");
  return { rows: batch as TRow[], point };
};

const snapshotLatest = async (
  client: MongoClient,
  installKey: string,
  installId: string,
  upper: Long,
  point: SnapshotPoint,
): Promise<MongoInsightsProjectionEvent> => {
  const rows = await snapshotFind<MongoInsightsProjectionEvent>(
    client,
    MONGO_INSIGHTS_PROJECTION_EVENT_COLLECTION,
    {
      filter: {
        installKey,
        latestVersion: true,
        projectionSequence: { $lte: upper },
      },
      hint: "insights_projection_install_latest_idx",
      sort: { projectionSequence: -1 },
      limit: 1,
      point,
    },
  );
  const row = rows.rows[0];
  if (!row) throw new DatabasePluginInputError("invalid-result");
  assertMongoInsightsProjectionEvent(row);
  if (row.installId !== installId)
    throw new DatabasePluginInputError("invalid-result");
  return row;
};

const pageLive = async (
  client: MongoClient,
  input: InsightsLiveInstallationPageInput,
): Promise<InsightsLiveInstallationPage> => {
  const resumed = readLiveCursor(input);
  const collections = createMongoInsightsModelCollections(client);
  const requestedInstallId =
    input.kind === "installationId" ? input.installId : null;
  let snapshot: MongoInsightsLiveSnapshot;
  let state: MongoInsightsProjectionState;
  let point: SnapshotPoint;
  if (resumed !== undefined) {
    try {
      const saved = await collections.liveSnapshots.findOne(
        { _id: resumed.snapshotId },
        { promoteLongs: false },
      );
      if (!saved) throw new MongoInsightsSnapshotUnavailableError();
      if (saved.kind !== input.kind || saved.installId !== requestedInstallId)
        throw null;
      snapshot = saved;
      point = {
        seconds: saved.atClusterTimeSeconds,
        increment: saved.atClusterTimeIncrement,
      };
      const stateRead = await snapshotFind<MongoInsightsProjectionState>(
        client,
        MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
        {
          filter: { _id: MONGO_INSIGHTS_PROJECTION_STATE_ID },
          limit: 1,
          point,
        },
      );
      state = assertMongoInsightsProjectionState(stateRead.rows[0] ?? null);
    } catch (error) {
      if (error instanceof MongoInsightsSnapshotUnavailableError) throw error;
      if (error instanceof MongoServerError) throw error;
      throw new DatabasePluginInputError("invalid-query");
    }
  } else {
    const stateRead = await snapshotFind<MongoInsightsProjectionState>(
      client,
      MONGO_INSIGHTS_PROJECTION_STATE_COLLECTION,
      { filter: { _id: MONGO_INSIGHTS_PROJECTION_STATE_ID }, limit: 1 },
    );
    state = assertMongoInsightsProjectionState(stateRead.rows[0] ?? null);
    point = stateRead.point;
    snapshot = {
      _id: randomUUID(),
      kind: input.kind,
      installId: requestedInstallId,
      sourceId: state.sourceId,
      sourceGeneration: mongoInsightsProjectionSourceGeneration(state),
      projectionUpper: state.nextProjectionSequence,
      observedAtMs: Date.now(),
      atClusterTimeSeconds: point.seconds,
      atClusterTimeIncrement: point.increment,
    };
    await collections.liveSnapshots.insertOne(snapshot);
  }
  if (
    state.phase !== "ready" ||
    state.sourceId !== snapshot.sourceId ||
    !state.nextProjectionSequence.equals(snapshot.projectionUpper)
  )
    throw new InsightsQueryNotReadyError();
  assertMongoInsightsProjectionSourceGeneration(
    snapshot.sourceGeneration,
    state.sourceId,
    state.nextProjectionSequence,
  );
  const projection = projectionGeneration(state);
  const identity = JSON.stringify([
    "live",
    input.kind,
    requestedInstallId,
    snapshot._id,
  ]);
  if (resumed !== undefined && resumed.identity !== identity)
    throw new DatabasePluginInputError("invalid-query");
  const after = resumed?.after ?? null;
  let candidates: {
    readonly key: string;
    readonly value: InsightsInstallationRow;
  }[];
  if (input.kind === "installationId") {
    if (after !== null) {
      candidates = [];
    } else {
      const key = mongoInsightsInstallationKey(input.installId);
      const installations = await snapshotFind<MongoInsightsInstallation>(
        client,
        MONGO_INSIGHTS_INSTALLATION_COLLECTION,
        { filter: { _id: key }, limit: 1, point },
      );
      const installation = installations.rows[0];
      if (installation && installation.installId !== input.installId)
        throw new DatabasePluginInputError("invalid-result");
      candidates = installation
        ? [
            {
              key,
              value: installationRow(
                (
                  await snapshotLatest(
                    client,
                    key,
                    installation.installId,
                    state.nextProjectionSequence,
                    point,
                  )
                ).event,
              ),
            },
          ]
        : [];
    }
  } else {
    const installations = await snapshotFind<MongoInsightsInstallation>(
      client,
      MONGO_INSIGHTS_INSTALLATION_COLLECTION,
      {
        filter: after === null ? {} : { _id: { $gt: after } },
        hint: "_id_",
        sort: { _id: 1 },
        limit: input.limit + 1,
        point,
      },
    );
    candidates = await Promise.all(
      installations.rows.map(async (installation) => {
        if (
          mongoInsightsInstallationKey(installation.installId) !==
          installation._id
        )
          throw new DatabasePluginInputError("invalid-result");
        return {
          key: installation._id,
          value: installationRow(
            (
              await snapshotLatest(
                client,
                installation._id,
                installation.installId,
                state.nextProjectionSequence,
                point,
              )
            ).event,
          ),
        };
      }),
    );
  }
  const readVersions = versions(snapshot.sourceGeneration, projection);
  const build = (
    rows: readonly InsightsInstallationRow[],
    nextCursor: string | null,
  ) => ({
    state: "ready" as const,
    versions: readVersions,
    data: {
      data: rows,
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "live" as const,
        cutoff: {
          kind: "projection" as const,
          observedAtMs: snapshot.observedAtMs,
          projectionGeneration: projection,
        },
      },
      total: { state: "unavailable" as const },
    },
  });
  const fitted = fitPage(
    candidates,
    input.limit,
    (key) => makeCursor(identity, key),
    build,
  );
  const result = build(fitted.rows, fitted.nextCursor);
  assertInsightsPageContract(result, input.limit);
  return result;
};

const descriptor = (
  input: InsightsPublishedInstallationPageInput,
): {
  readonly descriptor: MongoInsightsSearchDescriptor;
  readonly hash: string;
} => {
  const value: MongoInsightsSearchDescriptor =
    input.kind === "contains"
      ? { kind: "contains", normalized: input.query.toLowerCase() }
      : { kind: "userId", userId: input.userId };
  if (
    (value.kind === "contains" && value.normalized.length === 0) ||
    (value.kind === "userId" && value.userId.length === 0)
  )
    throw new DatabasePluginInputError("invalid-query");
  return { descriptor: value, hash: mongoInsightsDigest([1, value]) };
};

const publication = (job: MongoInsightsSearchJob): InsightsPublication => {
  if (job.state !== "ready" || job.completedAtMs === null)
    throw new DatabasePluginInputError("invalid-result");
  return {
    id: job._id,
    asOfMs: job.asOfMs,
    completedAtMs: job.completedAtMs,
    sourceGeneration: job.sourceGeneration,
    accuracy: "exact",
  };
};

type SearchReservation = {
  readonly job: MongoInsightsSearchJob;
  readonly previous: MongoInsightsSearchJob | null;
};

const reserveSearch = async (
  client: MongoClient,
  collections: MongoInsightsModelCollections,
  query: ReturnType<typeof descriptor>,
  minAsOfMs: number | undefined,
): Promise<SearchReservation> =>
  client.withSession((session) =>
    session.withTransaction(async () => {
      const state = await readReadyState(collections, session);
      await collections.searchHeads.updateOne(
        { _id: query.hash },
        {
          $setOnInsert: {
            descriptor: query.descriptor,
            activeJobId: null,
            publicationJobId: null,
          },
        },
        { session, upsert: true },
      );
      const head = await collections.searchHeads.findOne(
        { _id: query.hash },
        { session },
      );
      if (
        !head ||
        JSON.stringify(head.descriptor) !== JSON.stringify(query.descriptor)
      )
        throw new DatabasePluginInputError("invalid-result");
      const previous = head.publicationJobId
        ? await collections.searchJobs.findOne(
            { _id: head.publicationJobId, queryHash: query.hash },
            { session, promoteLongs: false },
          )
        : null;
      if (
        previous &&
        previous.state === "ready" &&
        (minAsOfMs === undefined || previous.asOfMs >= minAsOfMs)
      )
        return { job: previous, previous: null };
      if (head.activeJobId) {
        const active = await collections.searchJobs.findOne(
          { _id: head.activeJobId, queryHash: query.hash },
          { session, promoteLongs: false },
        );
        if (!active) throw new DatabasePluginInputError("invalid-result");
        return { job: active, previous };
      }
      const job: MongoInsightsSearchJob = {
        _id: randomUUID(),
        queryHash: query.hash,
        descriptor: query.descriptor,
        state: "queued",
        sourceId: state.sourceId,
        sourceGeneration: mongoInsightsProjectionSourceGeneration(state),
        projectionUpper: state.nextProjectionSequence,
        asOfMs: Date.now(),
        completedAtMs: null,
        afterAliasSequence: null,
        afterAliasId: null,
        total: 0,
        leaseOwner: null,
        leaseEpoch: 0,
        leaseExpiresAt: null,
      };
      await collections.searchJobs.insertOne(job, { session });
      const saved = await collections.searchHeads.updateOne(
        { _id: query.hash, activeJobId: null },
        { $set: { activeJobId: job._id } },
        { session },
      );
      if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
      return { job, previous };
    }, transactionOptions),
  );

const pageSearchJob = async (
  collections: MongoInsightsModelCollections,
  input: InsightsPublishedInstallationPageInput,
  queryHash: string,
  job: MongoInsightsSearchJob,
  state: "ready" | "stale",
  refreshId?: string,
): Promise<InsightsPublishedInstallationPage> => {
  const published = publication(job);
  const readVersions = versions(job.sourceGeneration, job._id);
  const identity = JSON.stringify([
    "published",
    queryHash,
    job.sourceId,
    job._id,
  ]);
  const after = readCursor(input, identity);
  const rows = await collections.searchRows
    .find(
      {
        jobId: job._id,
        ...(after === null ? {} : { installKey: { $gt: after } }),
      },
      { singleBatch: true },
    )
    .hint("insights_search_rows_idx")
    .sort({ installKey: 1 })
    .limit(input.limit + 1)
    .batchSize(input.limit + 1)
    .toArray();
  const candidates = rows.map((row) => {
    if (
      mongoInsightsInstallationKey(row.installId) !== row.installKey ||
      row.event.install_id !== row.installId
    )
      throw new DatabasePluginInputError("invalid-result");
    return { key: row.installKey, value: installationRow(row.event) };
  });
  const build = (
    values: readonly InsightsInstallationRow[],
    nextCursor: string | null,
  ) => ({
    state,
    versions: readVersions,
    data: {
      data: values,
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "snapshot" as const,
        cutoff: { kind: "publication" as const, publication: published },
      },
      total: {
        state: "exact" as const,
        value: job.total!,
        sourceGeneration: job.sourceGeneration,
      },
    },
    ...(state === "stale" ? { refresh: { id: refreshId! } } : {}),
  });
  const fitted = fitPage(
    candidates,
    input.limit,
    (key) => makeCursor(identity, key),
    build,
  );
  const result = build(fitted.rows, fitted.nextCursor);
  assertInsightsPageContract(result, input.limit);
  return result;
};

const pagePublished = async (
  client: MongoClient,
  collections: MongoInsightsModelCollections,
  input: InsightsPublishedInstallationPageInput,
): Promise<InsightsPublishedInstallationPage> => {
  const query = descriptor(input);
  const cursor = readPublishedCursor(input, query.hash);
  let pinnedPublicationId = cursor?.publicationId ?? input.publicationId;
  if (cursor !== undefined) {
    const state = await readReadyState(collections);
    if (cursor.sourceId !== state.sourceId)
      throw new DatabasePluginInputError("invalid-query");
  }
  if (pinnedPublicationId !== undefined) {
    const job = await collections.searchJobs.findOne(
      { _id: pinnedPublicationId, queryHash: query.hash },
      { promoteLongs: false },
    );
    if (!job || job.state !== "ready")
      return { state: "expired", publicationId: pinnedPublicationId };
    if (input.minAsOfMs !== undefined && job.asOfMs < input.minAsOfMs)
      return { state: "expired", publicationId: pinnedPublicationId };
    return pageSearchJob(collections, input, query.hash, job, "ready");
  }
  const reservation = await reserveSearch(
    client,
    collections,
    query,
    input.minAsOfMs,
  );
  if (reservation.job.state === "failed") {
    return {
      state: "failed",
      versions: versions(reservation.job.sourceGeneration, reservation.job._id),
      error: { code: "migration-poison", jobId: reservation.job._id },
    };
  }
  if (reservation.previous?.state === "ready") {
    return pageSearchJob(
      collections,
      input,
      query.hash,
      reservation.previous,
      "stale",
      reservation.job._id,
    );
  }
  if (reservation.job.state !== "ready") {
    return {
      state: "preparing",
      versions: versions(reservation.job.sourceGeneration, reservation.job._id),
      job: { id: reservation.job._id },
    };
  }
  return pageSearchJob(
    collections,
    input,
    query.hash,
    reservation.job,
    "ready",
  );
};

const matches = (
  descriptor: MongoInsightsSearchDescriptor,
  alias: MongoInsightsAlias,
): boolean =>
  descriptor.kind === "userId"
    ? alias.kind === "user" && alias.value === descriptor.userId
    : alias.normalized.includes(descriptor.normalized);

const JOB_LEASE_MS = 120_000;

type JobLease = {
  readonly owner: string;
  readonly epoch: number;
};

const searchLeaseFilter = (jobId: string, lease: JobLease) => ({
  _id: jobId,
  leaseOwner: lease.owner,
  leaseEpoch: lease.epoch,
  $expr: { $gt: ["$leaseExpiresAt", "$$NOW"] },
});

export const stepMongoInsightsSearch = async (
  client: MongoClient,
  jobId: string,
  limit: number,
  usage?: MongoInsightsStepUsage,
): Promise<"progress" | "published" | "failed"> => {
  const collections = createMongoInsightsModelCollections(client, usage);
  const owner = randomUUID();
  const claimed = await collections.searchJobs.findOneAndUpdate(
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
              amount: JOB_LEASE_MS,
            },
          },
          leaseEpoch: { $add: ["$leaseEpoch", 1] },
        },
      },
    ],
    { returnDocument: "after", promoteLongs: false },
  );
  if (claimed === null) {
    const terminal = await collections.searchJobs.findOne(
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
        const job = await collections.searchJobs.findOne(
          searchLeaseFilter(jobId, lease),
          { session, promoteLongs: false },
        );
        if (!job) throw new InsightsQueryNotReadyError();
        if (job.state === "ready") return "published" as const;
        if (job.state === "failed") return "failed" as const;
        const readAliases = (
          sequence:
            | { readonly $eq: Long }
            | { readonly $gt?: Long; readonly $lte: Long },
          afterId: string | null,
          readLimit: number,
        ) =>
          collections.aliases
            .find(
              {
                ...(job.descriptor.kind === "userId"
                  ? { kind: "user" as const, value: job.descriptor.userId }
                  : {}),
                ...(afterId === null ? {} : { _id: { $gt: afterId } }),
                firstProjectionSequence: sequence,
              },
              { session, promoteLongs: false, singleBatch: true },
            )
            .hint(
              job.descriptor.kind === "userId"
                ? "insights_alias_exact_idx"
                : "insights_alias_scan_idx",
            )
            .sort({ firstProjectionSequence: 1, _id: 1 })
            .limit(readLimit)
            .batchSize(readLimit)
            .toArray();
        const ties =
          job.afterAliasSequence === null || job.afterAliasId === null
            ? []
            : await readAliases(
                { $eq: job.afterAliasSequence },
                job.afterAliasId,
                limit,
              );
        const aliases =
          ties.length === limit
            ? ties
            : [
                ...ties,
                ...(await readAliases(
                  {
                    ...(job.afterAliasSequence === null
                      ? {}
                      : { $gt: job.afterAliasSequence }),
                    $lte: job.projectionUpper,
                  },
                  null,
                  limit - ties.length,
                )),
              ];
        if (usage !== undefined) usage.items += aliases.length;
        let inserted = 0;
        for (const alias of aliases) {
          if (!matches(job.descriptor, alias)) continue;
          if (
            mongoInsightsInstallationKey(alias.installId) !== alias.installKey
          )
            throw new DatabasePluginInputError("invalid-result");
          const latest = await readLatest(
            collections,
            alias.installKey,
            alias.installId,
            job.projectionUpper,
            session,
          );
          const rowId = mongoInsightsDigest([job._id, alias.installKey]);
          const saved = await collections.searchRows.updateOne(
            { _id: rowId },
            {
              $setOnInsert: {
                jobId: job._id,
                installKey: alias.installKey,
                installId: alias.installId,
                event: latest.event,
              },
            },
            { session, upsert: true },
          );
          inserted += saved.upsertedCount;
        }
        const last = aliases.at(-1);
        if (aliases.length === limit && last) {
          const saved = await collections.searchJobs.updateOne(
            {
              ...searchLeaseFilter(job._id, lease),
              state: { $in: ["queued", "preparing"] },
            },
            {
              $set: {
                state: "preparing",
                afterAliasSequence: last.firstProjectionSequence,
                afterAliasId: last._id,
                leaseOwner: null,
                leaseExpiresAt: null,
              },
              $inc: { total: inserted },
            },
            { session },
          );
          if (saved.matchedCount !== 1) throw new InsightsQueryNotReadyError();
          return "progress" as const;
        }
        const completedAtMs = Date.now();
        const saved = await collections.searchJobs.updateOne(
          {
            ...searchLeaseFilter(job._id, lease),
            state: { $in: ["queued", "preparing"] },
          },
          {
            $set: {
              state: "ready",
              completedAtMs,
              leaseOwner: null,
              leaseExpiresAt: null,
            },
            $inc: { total: inserted },
          },
          { session },
        );
        if (saved.matchedCount !== 1)
          throw new DatabasePluginInputError("invalid-result");
        await collections.searchHeads.updateOne(
          { _id: job.queryHash, activeJobId: job._id },
          { $set: { activeJobId: null, publicationJobId: job._id } },
          { session },
        );
        return "published" as const;
      }, transactionOptions),
    );
  } catch (error) {
    const corruption =
      error instanceof DatabasePluginInputError &&
      error.code === "invalid-result";
    await collections.searchJobs.updateOne(
      {
        ...searchLeaseFilter(jobId, lease),
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

function pageInstallations(
  client: MongoClient,
  input: InsightsLiveInstallationPageInput,
): Promise<InsightsLiveInstallationPage>;
function pageInstallations(
  client: MongoClient,
  input: InsightsPublishedInstallationPageInput,
): Promise<InsightsPublishedInstallationPage>;
function pageInstallations(
  client: MongoClient,
  input: InsightsInstallationPageInput,
): Promise<InsightsInstallationPage>;
async function pageInstallations(
  client: MongoClient,
  input: InsightsInstallationPageInput,
): Promise<InsightsInstallationPage> {
  input = validateInput(input);
  const collections = createMongoInsightsModelCollections(client);
  try {
    return input.kind === "all" || input.kind === "installationId"
      ? await pageLive(client, input)
      : await pagePublished(client, collections, input);
  } catch (error) {
    if (error instanceof MongoInsightsSnapshotUnavailableError)
      return {
        state: "failed",
        versions: failedVersions(),
        error: { code: "storage-not-ready" },
      };
    if (
      error instanceof MongoServerError &&
      (error.code === 239 ||
        error.code === 246 ||
        error.codeName === "SnapshotTooOld" ||
        error.codeName === "SnapshotUnavailable")
    )
      return {
        state: "failed",
        versions: failedVersions(),
        error: { code: "storage-not-ready" },
      };
    if (!(error instanceof InsightsQueryNotReadyError)) throw error;
    return {
      state: "failed",
      versions: failedVersions(),
      error: { code: "source-not-ready" },
    };
  }
}

export const createMongoInsightsInstallationQueries = (
  client: MongoClient,
) => ({
  pageInstallations: (input: InsightsInstallationPageInput) =>
    pageInstallations(client, input),
});
