import {
  DatabasePluginInputError,
  type BundleEventRow,
  type InsightsInstallationRow,
  type InsightsPublishedInstallationPage,
  type InsightsPublishedInstallationPageInput,
  type InsightsReportInput,
  type InsightsReportPage,
  type InsightsReportPageInput,
  type InsightsReportPublication,
  type InsightsReportResult,
} from "@hot-updater/plugin-core";
import {
  assertInsightsExpiredReadContract,
  assertInsightsFailedReadContract,
  assertInsightsMaintenanceInputContract,
  assertInsightsPageContract,
  assertInsightsPreparingReadContract,
  assertInsightsReportPageResultContract,
  assertInsightsReportResultContract,
  canonicalInsightsJson,
  createInsightsReportPageCursor,
  createInsightsReportProjection,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_PAGE_MAX_BYTES,
  readInsightsReportPageQuery,
  readInsightsReportQuery,
} from "@hot-updater/plugin-core/internal";
import {
  FieldPath,
  type DocumentData,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";

import { parseFirebaseBundleEventRow } from "./firebaseDatabaseParser";
import {
  FIREBASE_INSIGHTS_LAYOUT_VERSION,
  FIREBASE_INSIGHTS_SOURCE_IDS,
  FIREBASE_INSIGHTS_SOURCE_SHARDS,
  assertFirebaseEventInput,
  assertFirebaseInstallationIdentity,
  firebaseEventDocumentId,
  firebaseEventScopeKey,
  firebaseInstallationKey,
} from "./firebaseEventIndex";
import type { FirebaseInsightsCollections } from "./firebaseInsights";

const JOB_VERSION = 1;
const MAX_REPORT_JOB_ITEMS = 45;
const MAX_SEARCH_JOB_ITEMS = 45;
const SOURCE_IDS = FIREBASE_INSIGHTS_SOURCE_IDS;

type SearchQuery =
  | { readonly kind: "userId"; readonly value: string }
  | { readonly kind: "contains"; readonly value: string };

type JobKind = "report" | "search";

export interface RunFirebaseInsightsJobInput {
  readonly jobId: string;
  readonly maxItems: number;
  readonly maxRequests: number;
  readonly nowMs: number;
}

export interface RunFirebaseInsightsJobResult {
  readonly state: "building" | "ready" | "failed";
  readonly phase: string;
  readonly processed: number;
  readonly usage: {
    readonly items: number;
    readonly requests: number;
    readonly bytes: number;
  };
}

type FirebaseInsightsJobStepResult = Omit<
  RunFirebaseInsightsJobResult,
  "usage"
>;

type FirebaseInsightsJobUsageMeter = {
  items: number;
  requests: number;
  bytes: number;
};

const recordNativeRead = (
  meter: FirebaseInsightsJobUsageMeter,
  snapshot: unknown,
): void => {
  meter.requests += 1;
  const values = Array.isArray(snapshot)
    ? snapshot
    : isRecord(snapshot) && Array.isArray(snapshot.docs)
      ? snapshot.docs
      : [snapshot];
  for (const value of values) {
    if (
      typeof value === "object" &&
      value !== null &&
      Reflect.get(value, "exists") !== false &&
      typeof Reflect.get(value, "data") === "function"
    ) {
      const data = Reflect.apply(Reflect.get(value, "data"), value, []);
      if (data !== undefined) {
        meter.bytes += getCanonicalInsightsJsonByteLength(data);
      }
    }
  }
};

const measuredTransaction = (
  transaction: Transaction,
  meter: FirebaseInsightsJobUsageMeter,
): Transaction =>
  new Proxy(transaction, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "get" || property === "getAll") {
        return (...args: unknown[]) =>
          Promise.resolve(Reflect.apply(value, target, args)).then(
            (snapshot) => {
              recordNativeRead(meter, snapshot);
              return snapshot;
            },
          );
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const runMeasuredTransaction = async <TResult>(
  db: Firestore,
  meter: FirebaseInsightsJobUsageMeter,
  callback: (transaction: Transaction) => Promise<TResult>,
  _options?: { readonly maxAttempts: number },
): Promise<TResult> => {
  const result = await db.runTransaction(
    (transaction) => callback(measuredTransaction(transaction, meter)),
    { maxAttempts: 1 },
  );
  meter.requests += 1;
  return result;
};

class FirebaseInsightsStorageCorruptionError extends DatabasePluginInputError {
  constructor() {
    super("invalid-result");
  }
}

const invalidQuery = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const invalidResult = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};

const isTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isRecord = (value: unknown): value is DocumentData =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readStoredEvent = (data: DocumentData, path: string): BundleEventRow => {
  try {
    const row = parseFirebaseBundleEventRow(data, path);
    assertFirebaseEventInput(row);
    return row;
  } catch {
    return invalidResult();
  }
};

const assertContiguousSourceBatch = (
  sequences: readonly number[],
  afterSequence: number,
  upperSequence: number,
  sourceComplete: boolean,
): void => {
  sequences.forEach((sequence, index) => {
    if (sequence !== afterSequence + index + 1 || sequence > upperSequence) {
      storageCorruptionError();
    }
  });
  if (sourceComplete && (sequences.at(-1) ?? afterSequence) !== upperSequence) {
    storageCorruptionError();
  }
};

const toInstallationRow = (row: BundleEventRow): InsightsInstallationRow => ({
  id: row.id,
  install_id: row.install_id,
  user_id: row.user_id,
  username: row.username,
  to_bundle_id: row.to_bundle_id,
  type: row.type,
  platform: row.platform,
  app_version: row.app_version,
  channel: row.channel,
  cohort: row.cohort,
  received_at_ms: row.received_at_ms,
});

const sourceShardValue = (index: number): number | "legacy" =>
  index === FIREBASE_INSIGHTS_SOURCE_SHARDS ? "legacy" : index;

const storageCorruptionError = (): never => {
  throw new FirebaseInsightsStorageCorruptionError();
};

const readSequence = (value: unknown): number => {
  if (!isRecord(value) || !isTimestamp(value.sequence)) return invalidResult();
  return value.sequence;
};

const readSourceClock = (value: unknown, sourceIndex: number): number => {
  if (
    !isRecord(value) ||
    value.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
    value.shard !== sourceShardValue(sourceIndex) ||
    !isTimestamp(value.sequence) ||
    !isTimestamp(value.observedAtMs)
  ) {
    return storageCorruptionError();
  }
  return value.sequence;
};

const readCurrentSourceGeneration = async (
  collections: FirebaseInsightsCollections,
): Promise<string> => {
  const documents = await collections.sourceClocks.firestore.getAll(
    ...SOURCE_IDS.map((id) => collections.sourceClocks.doc(id)),
  );
  const vector = SOURCE_IDS.map((id, index) => {
    const document = documents[index]!;
    if (!document.exists) return storageCorruptionError();
    return [id, readSourceClock(document.data(), index)] as const;
  });
  return firebaseEventScopeKey(JSON.stringify(vector));
};

const readCorruptionGeneration = async (
  collections: FirebaseInsightsCollections,
): Promise<string> => {
  const documents = await collections.sourceClocks.firestore.getAll(
    ...SOURCE_IDS.map((id) => collections.sourceClocks.doc(id)),
  );
  return firebaseEventScopeKey(
    canonicalInsightsJson(
      SOURCE_IDS.map((id, index) => {
        const data = documents[index]!.data();
        return [
          id,
          documents[index]!.exists,
          data?.version ?? null,
          data?.shard ?? null,
          data?.sequence ?? null,
          data?.observedAtMs ?? null,
        ];
      }),
    ),
  );
};

const queryHeadId = (
  namespace: string,
  kind: JobKind,
  semanticKey: string,
): string =>
  firebaseEventScopeKey(
    canonicalInsightsJson([
      FIREBASE_INSIGHTS_LAYOUT_VERSION,
      namespace,
      kind,
      semanticKey,
    ]),
  );

const nextJobId = (headId: string, revision: number): string =>
  firebaseEventScopeKey(canonicalInsightsJson([headId, revision]));

const versions = (data: DocumentData) => ({
  schemaVersion: data.schemaVersion as string,
  storageVersion: data.storageVersion as string,
  projectionGeneration: data.projectionGeneration as string,
  sourceGeneration: data.sourceGeneration as string,
});

const publicationBase = (data: DocumentData) => ({
  id: data.id as string,
  asOfMs: data.asOfMs as number,
  completedAtMs: data.completedAtMs as number,
  sourceGeneration: data.sourceGeneration as string,
  accuracy: "exact" as const,
});

const assertJobDocument = (data: unknown, jobId: string): DocumentData => {
  if (
    !isRecord(data) ||
    data.version !== JOB_VERSION ||
    data.id !== jobId ||
    (data.kind !== "search" && data.kind !== "report") ||
    typeof data.headId !== "string" ||
    typeof data.semanticKey !== "string" ||
    typeof data.namespace !== "string" ||
    typeof data.state !== "string" ||
    typeof data.sourceGeneration !== "string" ||
    typeof data.projectionGeneration !== "string"
  ) {
    return invalidResult();
  }
  return data;
};

const readProjection = (value: unknown): DocumentData | null => {
  if (!isRecord(value) || value.state !== "ready") return null;
  if (
    value.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
    typeof value.generation !== "string" ||
    !isTimestamp(value.observedAtMs)
  ) {
    return invalidResult();
  }
  return value;
};

const createJobData = (
  id: string,
  headId: string,
  namespace: string,
  kind: JobKind,
  semanticKey: string,
  query: SearchQuery | ReturnType<typeof readInsightsReportQuery>["query"],
  sourceGeneration: string,
  upperSequences: readonly number[],
  asOfMs: number,
) => ({
  version: JOB_VERSION,
  id,
  headId,
  namespace,
  kind,
  semanticKey,
  query,
  state: "building",
  phase: kind === "search" ? "searchScan" : "scan",
  sourceGeneration,
  projectionGeneration: sourceGeneration,
  schemaVersion: "firebase-insights-index-v2",
  storageVersion: "firebase-insights-v2",
  asOfMs,
  completedAtMs: null,
  upperSequences,
  sourceIndex: 0,
  afterSequence: 0,
  afterKey: null,
  afterDocumentId: null,
  total: 0,
  summaryEntries: [],
  revision: 1,
});

type QueryResolution =
  | { readonly state: "source-not-ready" }
  | { readonly state: "job"; readonly job: DocumentData };

const resolveQueryJob = async (
  collections: FirebaseInsightsCollections,
  namespace: string,
  kind: JobKind,
  semanticKey: string,
  query: SearchQuery | ReturnType<typeof readInsightsReportQuery>["query"],
  minAsOfMs: number | undefined,
): Promise<QueryResolution> => {
  const headId = queryHeadId(namespace, kind, semanticKey);
  const headRef = collections.heads.doc(headId);
  const projectionRef = collections.control.doc("projection");
  return collections.heads.firestore.runTransaction(
    async (transaction): Promise<QueryResolution> => {
      const [headDocument, projectionDocument] = await transaction.getAll(
        headRef,
        projectionRef,
      );
      const projectionData = projectionDocument.data();
      const head = headDocument.data();
      const reserve = async (jobId: string): Promise<DocumentData | null> => {
        const projection = readProjection(projectionData);
        if (projection === null) return null;
        const clocks = await transaction.getAll(
          ...SOURCE_IDS.map((id) => collections.sourceClocks.doc(id)),
        );
        const vector = SOURCE_IDS.map((id, index) => {
          const document = clocks[index]!;
          if (!document.exists) return storageCorruptionError();
          return [id, readSourceClock(document.data(), index)] as const;
        });
        const sourceGeneration = firebaseEventScopeKey(JSON.stringify(vector));
        return createJobData(
          jobId,
          headId,
          namespace,
          kind,
          semanticKey,
          query,
          sourceGeneration,
          vector.map(([, sequence]) => sequence),
          Date.now(),
        );
      };
      if (head === undefined) {
        const jobId = nextJobId(headId, 1);
        const job = await reserve(jobId);
        if (job === null) return { state: "source-not-ready" };
        transaction.create(collections.jobs.doc(jobId), job);
        transaction.create(headRef, {
          version: JOB_VERSION,
          namespace,
          kind,
          semanticKey,
          revision: 1,
          currentJobId: jobId,
          previousPublicationId: null,
        });
        return { state: "job", job };
      }
      if (
        head.version !== JOB_VERSION ||
        head.namespace !== namespace ||
        head.kind !== kind ||
        head.semanticKey !== semanticKey ||
        !Number.isSafeInteger(head.revision) ||
        typeof head.currentJobId !== "string"
      ) {
        return invalidResult();
      }
      const current = await transaction.get(
        collections.jobs.doc(head.currentJobId),
      );
      const job = assertJobDocument(current.data(), head.currentJobId);
      if (
        job.state === "ready" &&
        minAsOfMs !== undefined &&
        (!isTimestamp(job.asOfMs) || job.asOfMs < minAsOfMs)
      ) {
        const revision = head.revision + 1;
        const jobId = nextJobId(headId, revision);
        const refresh = await reserve(jobId);
        if (refresh === null) return { state: "source-not-ready" };
        transaction.create(collections.jobs.doc(jobId), refresh);
        transaction.update(headRef, {
          revision,
          currentJobId: jobId,
          previousPublicationId: job.id,
        });
        return { state: "job", job: refresh };
      }
      return { state: "job", job };
    },
    { maxAttempts: 1 },
  );
};

const failedRead = (job: DocumentData) => ({
  state: "failed" as const,
  versions: versions(job),
  error:
    job.failureCode === "migration-poison"
      ? { code: "migration-poison" as const, jobId: job.id as string }
      : job.failureCode === "storage-corruption"
        ? { code: "storage-corruption" as const }
        : { code: "preparation-failed" as const, jobId: job.id as string },
});

const preparingRead = (job: DocumentData) => ({
  state: "preparing" as const,
  versions: versions(job),
  job: { id: job.id as string },
});

const readPublication = async (
  collections: FirebaseInsightsCollections,
  publicationId: string,
  namespace: string,
  kind: JobKind,
  semanticKey?: string,
): Promise<DocumentData | null> => {
  const document = await collections.publications.doc(publicationId).get();
  if (!document.exists) return null;
  const data = document.data()!;
  if (
    data.namespace !== namespace ||
    data.kind !== kind ||
    (semanticKey !== undefined && data.semanticKey !== semanticKey)
  ) {
    return null;
  }
  if (
    data.version !== JOB_VERSION ||
    data.id !== publicationId ||
    !isTimestamp(data.asOfMs) ||
    !isTimestamp(data.completedAtMs) ||
    data.completedAtMs < data.asOfMs ||
    typeof data.sourceGeneration !== "string" ||
    typeof data.projectionGeneration !== "string"
  ) {
    return invalidResult();
  }
  return data;
};

const searchQuery = (
  input: InsightsPublishedInstallationPageInput,
): { readonly query: SearchQuery; readonly semanticKey: string } => {
  const fields =
    input.kind === "userId"
      ? ["kind", "userId", "publicationId", "minAsOfMs", "limit", "cursor"]
      : ["kind", "query", "publicationId", "minAsOfMs", "limit", "cursor"];
  const raw = input.kind === "userId" ? input.userId : input.query;
  if (
    !Object.keys(input).every((field) => fields.includes(field)) ||
    typeof raw !== "string" ||
    (input.kind === "contains" && raw.length === 0) ||
    (input.publicationId !== undefined &&
      (typeof input.publicationId !== "string" ||
        input.publicationId.length === 0)) ||
    (input.minAsOfMs !== undefined && !isTimestamp(input.minAsOfMs))
  ) {
    return invalidQuery();
  }
  const value = input.kind === "contains" ? raw.toLowerCase() : raw;
  return {
    query: { kind: input.kind, value },
    semanticKey: firebaseEventScopeKey(JSON.stringify([input.kind, value])),
  };
};

const searchCursor = (
  input: InsightsPublishedInstallationPageInput,
  namespace: string,
  semanticKey: string,
  publicationId: string,
): string | undefined => {
  if (input.cursor === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    return invalidQuery();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    value[0] !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
    value[1] !== namespace ||
    value[2] !== semanticKey ||
    value[3] !== publicationId ||
    typeof value[4] !== "string" ||
    !/^[0-9a-f]{64}$/.test(value[4])
  ) {
    return invalidQuery();
  }
  return value[4];
};

const searchCursorPublication = (
  input: InsightsPublishedInstallationPageInput,
  namespace: string,
  semanticKey: string,
): string | undefined => {
  if (input.cursor === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    return invalidQuery();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    value[0] !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
    value[1] !== namespace ||
    value[2] !== semanticKey ||
    typeof value[3] !== "string" ||
    typeof value[4] !== "string" ||
    !/^[0-9a-f]{64}$/.test(value[4])
  ) {
    return invalidQuery();
  }
  return value[3];
};

const readSearchPage = async (
  collections: FirebaseInsightsCollections,
  namespace: string,
  input: InsightsPublishedInstallationPageInput,
  semanticKey: string,
  publication: DocumentData,
  staleJob?: DocumentData,
): Promise<InsightsPublishedInstallationPage> => {
  const after = searchCursor(input, namespace, semanticKey, publication.id);
  let query = collections.work
    .where("jobId", "==", publication.id)
    .where("recordKind", "==", "searchRow")
    .orderBy("orderKey", "asc");
  if (after) query = query.startAfter(after);
  const snapshot = await query.limit(input.limit + 1).get();
  const documents: typeof snapshot.docs = [];
  const data: InsightsInstallationRow[] = [];
  for (const document of snapshot.docs.slice(0, input.limit)) {
    const value = document.data();
    if (
      typeof value.orderKey !== "string" ||
      !isRecord(value.row) ||
      firebaseInstallationKey(String(value.row.install_id)) !== value.orderKey
    ) {
      return invalidResult();
    }
    const row = value.row as InsightsInstallationRow;
    if (
      data.length > 0 &&
      getCanonicalInsightsJsonByteLength([...data, row]) + 64 * 1024 >
        INSIGHTS_PAGE_MAX_BYTES
    ) {
      break;
    }
    documents.push(document);
    data.push(row);
  }
  const last = documents.at(-1)?.data().orderKey;
  const nextCursor =
    snapshot.size > documents.length && typeof last === "string"
      ? JSON.stringify([
          FIREBASE_INSIGHTS_LAYOUT_VERSION,
          namespace,
          semanticKey,
          publication.id,
          last,
        ])
      : null;
  const page = {
    state: staleJob ? ("stale" as const) : ("ready" as const),
    versions: {
      schemaVersion: publication.schemaVersion,
      storageVersion: publication.storageVersion,
      projectionGeneration: publication.projectionGeneration,
      sourceGeneration: publication.sourceGeneration,
    },
    data: {
      data,
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "snapshot" as const,
        cutoff: {
          kind: "publication" as const,
          publication: publicationBase(publication),
        },
      },
      total: {
        state: "exact" as const,
        value: publication.total as number,
        sourceGeneration: publication.sourceGeneration as string,
      },
    },
    ...(staleJob ? { refresh: { id: staleJob.id as string } } : {}),
  };
  try {
    assertInsightsPageContract(page, input.limit);
  } catch {
    return invalidResult();
  }
  return page;
};

const pageFirebaseInsightsPublishedInstallationsUnsafe = async (
  collections: FirebaseInsightsCollections,
  namespace: string,
  input: InsightsPublishedInstallationPageInput,
): Promise<InsightsPublishedInstallationPage> => {
  const { query, semanticKey } = searchQuery(input);
  const cursorPublicationId = searchCursorPublication(
    input,
    namespace,
    semanticKey,
  );
  if (
    input.publicationId !== undefined &&
    cursorPublicationId !== undefined &&
    input.publicationId !== cursorPublicationId
  ) {
    return invalidQuery();
  }
  const pinnedPublicationId = input.publicationId ?? cursorPublicationId;
  if (pinnedPublicationId !== undefined) {
    const publication = await readPublication(
      collections,
      pinnedPublicationId,
      namespace,
      "search",
      semanticKey,
    );
    if (publication === null) {
      const result = {
        state: "expired" as const,
        publicationId: pinnedPublicationId,
      };
      assertInsightsExpiredReadContract(result);
      return result;
    }
    if (input.minAsOfMs !== undefined && publication.asOfMs < input.minAsOfMs) {
      const result = {
        state: "expired" as const,
        publicationId: pinnedPublicationId,
      };
      assertInsightsExpiredReadContract(result);
      return result;
    }
    return readSearchPage(
      collections,
      namespace,
      input,
      semanticKey,
      publication,
    );
  }
  const resolved = await resolveQueryJob(
    collections,
    namespace,
    "search",
    semanticKey,
    query,
    input.minAsOfMs,
  );
  if (resolved.state === "source-not-ready") {
    const result = {
      state: "failed" as const,
      versions: {
        schemaVersion: "firebase-insights-index-v2",
        storageVersion: "firebase-insights-v2",
        projectionGeneration: null,
        sourceGeneration: await readCurrentSourceGeneration(collections),
      },
      error: { code: "source-not-ready" as const },
    };
    assertInsightsFailedReadContract(result);
    return result;
  }
  const job = resolved.job;
  if (job.state === "failed") {
    const result = failedRead(job);
    assertInsightsFailedReadContract(result);
    return result;
  }
  if (job.state === "ready") {
    const publication = await readPublication(
      collections,
      job.id,
      namespace,
      "search",
      semanticKey,
    );
    if (publication === null) return invalidResult();
    return readSearchPage(
      collections,
      namespace,
      input,
      semanticKey,
      publication,
    );
  }
  const head = (await collections.heads.doc(job.headId).get()).data();
  if (typeof head?.previousPublicationId === "string") {
    const publication = await readPublication(
      collections,
      head.previousPublicationId,
      namespace,
      "search",
      semanticKey,
    );
    if (publication === null) return invalidResult();
    return readSearchPage(
      collections,
      namespace,
      input,
      semanticKey,
      publication,
      job,
    );
  }
  const result = preparingRead(job);
  assertInsightsPreparingReadContract(result);
  return result;
};

const storageCorruption = async (collections: FirebaseInsightsCollections) => {
  const result = {
    state: "failed" as const,
    versions: {
      schemaVersion: "firebase-insights-index-v2",
      storageVersion: "firebase-insights-v2",
      projectionGeneration: null,
      sourceGeneration: await readCorruptionGeneration(collections),
    },
    error: { code: "storage-corruption" as const },
  };
  assertInsightsFailedReadContract(result);
  return result;
};

export const pageFirebaseInsightsPublishedInstallations = async (
  collections: FirebaseInsightsCollections,
  namespace: string,
  input: InsightsPublishedInstallationPageInput,
): Promise<InsightsPublishedInstallationPage> => {
  try {
    return await pageFirebaseInsightsPublishedInstallationsUnsafe(
      collections,
      namespace,
      input,
    );
  } catch (error) {
    if (
      error instanceof DatabasePluginInputError &&
      error.code === "invalid-result"
    ) {
      return storageCorruption(collections);
    }
    throw error;
  }
};

const reportPublication = (data: DocumentData): InsightsReportPublication =>
  ({
    ...publicationBase(data),
    kind: data.query.kind,
    summary: data.summary,
  }) as InsightsReportPublication;

const getFirebaseInsightsReportUnsafe = async (
  collections: FirebaseInsightsCollections,
  namespace: string,
  input: InsightsReportInput,
): Promise<InsightsReportResult> => {
  const { query, semanticKey, minAsOfMs } = readInsightsReportQuery(input);
  const resolved = await resolveQueryJob(
    collections,
    namespace,
    "report",
    semanticKey,
    query,
    minAsOfMs,
  );
  if (resolved.state === "source-not-ready") {
    const result = {
      state: "failed" as const,
      versions: {
        schemaVersion: "firebase-insights-index-v2",
        storageVersion: "firebase-insights-v2",
        projectionGeneration: null,
        sourceGeneration: await readCurrentSourceGeneration(collections),
      },
      error: { code: "source-not-ready" as const },
    };
    assertInsightsReportResultContract(result);
    return result;
  }
  const job = resolved.job;
  if (job.state === "failed") {
    const result = failedRead(job);
    assertInsightsReportResultContract(result);
    return result;
  }
  if (job.state === "ready") {
    const publication = await readPublication(
      collections,
      job.id,
      namespace,
      "report",
      semanticKey,
    );
    if (publication === null) return invalidResult();
    const result = {
      state: "ready" as const,
      versions: versions(publication),
      data: reportPublication(publication),
    };
    assertInsightsReportResultContract(result);
    return result;
  }
  const head = (await collections.heads.doc(job.headId).get()).data();
  if (typeof head?.previousPublicationId === "string") {
    const publication = await readPublication(
      collections,
      head.previousPublicationId,
      namespace,
      "report",
      semanticKey,
    );
    if (publication === null) return invalidResult();
    const result = {
      state: "stale" as const,
      versions: versions(publication),
      data: reportPublication(publication),
      refresh: { id: job.id as string },
    };
    assertInsightsReportResultContract(result);
    return result;
  }
  const result = preparingRead(job);
  assertInsightsReportResultContract(result);
  return result;
};

export const getFirebaseInsightsReport = async (
  collections: FirebaseInsightsCollections,
  namespace: string,
  input: InsightsReportInput,
): Promise<InsightsReportResult> => {
  try {
    return await getFirebaseInsightsReportUnsafe(collections, namespace, input);
  } catch (error) {
    if (
      error instanceof DatabasePluginInputError &&
      error.code === "invalid-result"
    ) {
      return storageCorruption(collections);
    }
    throw error;
  }
};

const reportSectionKey = (input: InsightsReportPageInput): string =>
  input.section === "movementSeries" || input.section === "movementCohorts"
    ? `${input.section}:${input.metric}`
    : input.section;

const reportSectionManifestKeys = (query: DocumentData): readonly string[] => {
  switch (query.kind) {
    case "bundleSummaries":
      return [];
    case "bundleDetail":
      return [
        "movementSeries:installed",
        "movementSeries:recovered",
        "movementCohorts:installed",
        "movementCohorts:recovered",
      ];
    case "installationOverview":
      return ["bundleDistribution"];
    case "activeOverview":
      return ["activeSeries", "bundleDistribution", "activeBundleSeries"];
    default:
      return invalidResult();
  }
};

const readSectionManifest = (
  publication: DocumentData,
): ReadonlyMap<string, number> => {
  if (!Array.isArray(publication.sectionManifest)) return invalidResult();
  const expected = reportSectionManifestKeys(publication.query);
  const manifest = new Map<string, number>();
  for (const item of publication.sectionManifest) {
    if (
      !isRecord(item) ||
      typeof item.sectionKey !== "string" ||
      !isTimestamp(item.total) ||
      manifest.has(item.sectionKey)
    ) {
      return invalidResult();
    }
    manifest.set(item.sectionKey, item.total);
  }
  if (
    manifest.size !== expected.length ||
    expected.some((sectionKey) => !manifest.has(sectionKey))
  ) {
    return invalidResult();
  }
  return manifest;
};

const reportCountId = (
  publicationId: string,
  sectionKey: string,
  bundleKey?: string,
): string =>
  firebaseEventScopeKey(
    canonicalInsightsJson([publicationId, sectionKey, bundleKey ?? null]),
  );

const hasBundleIdentity = (
  bundleKey: string,
  bundleId: unknown,
): bundleId is string =>
  typeof bundleId === "string" && firebaseEventScopeKey(bundleId) === bundleKey;

const pageFirebaseInsightsReportUnsafe = async (
  collections: FirebaseInsightsCollections,
  namespace: string,
  input: InsightsReportPageInput,
): Promise<InsightsReportPage> => {
  const parsed = readInsightsReportPageQuery(input, namespace);
  const publication = await readPublication(
    collections,
    input.publicationId,
    namespace,
    "report",
  );
  if (publication === null) {
    const result = {
      state: "expired" as const,
      publicationId: input.publicationId,
    };
    assertInsightsReportPageResultContract(result, input.limit);
    return result;
  }
  if (
    !isRecord(publication.query) ||
    typeof publication.query.kind !== "string"
  ) {
    return invalidResult();
  }
  const validSection =
    (publication.query.kind === "bundleDetail" &&
      (input.section === "movementSeries" ||
        input.section === "movementCohorts")) ||
    (publication.query.kind === "installationOverview" &&
      input.section === "bundleDistribution") ||
    (publication.query.kind === "activeOverview" &&
      (input.section === "activeSeries" ||
        input.section === "bundleDistribution" ||
        input.section === "activeBundleSeries"));
  if (!validSection) return invalidQuery();
  const sectionKey = reportSectionKey(input);
  const manifest = readSectionManifest(publication);
  if (!manifest.has(sectionKey)) return invalidResult();
  const requestedBundleId =
    input.section === "activeBundleSeries" ? input.bundleId : undefined;
  const bundleKey =
    requestedBundleId === undefined
      ? undefined
      : firebaseEventScopeKey(requestedBundleId);
  const count = await collections.reportCounts
    .doc(reportCountId(publication.id, sectionKey, bundleKey))
    .get();
  if (
    count.exists &&
    (count.data()?.publicationId !== publication.id ||
      count.data()?.sectionKey !== sectionKey ||
      count.data()?.bundleKey !== bundleKey ||
      (bundleKey !== undefined &&
        (!hasBundleIdentity(bundleKey, count.data()?.bundleId) ||
          count.data()?.bundleId !== requestedBundleId)) ||
      (bundleKey === undefined && count.data()?.bundleId !== undefined))
  ) {
    return invalidResult();
  }
  if (bundleKey === undefined && !count.exists) return invalidResult();
  const total =
    bundleKey === undefined
      ? manifest.get(sectionKey)!
      : count.exists
        ? readSequence(count.data())
        : 0;
  if (count.exists && readSequence(count.data()) !== total) {
    return invalidResult();
  }
  let query = collections.reportRows
    .where("publicationId", "==", publication.id)
    .where("sectionKey", "==", sectionKey);
  if (bundleKey !== undefined)
    query = query.where("bundleKey", "==", bundleKey);
  const ordinalField = bundleKey === undefined ? "ordinal" : "bundleOrdinal";
  query = query
    .orderBy(ordinalField, "asc")
    .startAt(Number(parsed.nextOrdinal));
  const nextOrdinal = Number(parsed.nextOrdinal);
  if (
    !Number.isSafeInteger(nextOrdinal) ||
    nextOrdinal < 0 ||
    nextOrdinal > total
  )
    return invalidResult();
  const snapshot = await query.limit(input.limit + 1).get();
  const expectedCandidates = Math.min(input.limit + 1, total - nextOrdinal);
  if (snapshot.size !== expectedCandidates) return invalidResult();
  const documents = snapshot.docs.slice(0, input.limit);
  documents.forEach((document, index) => {
    const value = document.data();
    if (
      value.publicationId !== publication.id ||
      value.sectionKey !== sectionKey ||
      (bundleKey !== undefined
        ? value.bundleKey !== bundleKey ||
          !hasBundleIdentity(bundleKey, value.row?.bundleId) ||
          value.row.bundleId !== requestedBundleId
        : sectionKey === "activeBundleSeries"
          ? typeof value.bundleKey !== "string" ||
            !hasBundleIdentity(value.bundleKey, value.row?.bundleId)
          : value.bundleKey !== undefined) ||
      value[ordinalField] !== nextOrdinal + index ||
      !isRecord(value.row)
    ) {
      return invalidResult();
    }
  });
  const data = documents.map((document) => document.data().row);
  const nextCursor =
    nextOrdinal + documents.length < total
      ? createInsightsReportPageCursor(
          input,
          String(nextOrdinal + documents.length),
          namespace,
        )
      : null;
  const result = {
    state: "ready" as const,
    versions: versions(publication),
    data: {
      data,
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "snapshot" as const,
        cutoff: {
          kind: "publication" as const,
          publication: publicationBase(publication),
        },
      },
      total: {
        state: "exact" as const,
        value: total,
        sourceGeneration: publication.sourceGeneration as string,
      },
      section: input.section,
      ...((input.section === "movementSeries" ||
        input.section === "movementCohorts") && { metric: input.metric }),
    },
  };
  try {
    assertInsightsReportPageResultContract(result, input.limit);
  } catch {
    return invalidResult();
  }
  return result;
};

export const pageFirebaseInsightsReport = async (
  collections: FirebaseInsightsCollections,
  namespace: string,
  input: InsightsReportPageInput,
): Promise<InsightsReportPage> => {
  try {
    return await pageFirebaseInsightsReportUnsafe(
      collections,
      namespace,
      input,
    );
  } catch (error) {
    if (
      error instanceof DatabasePluginInputError &&
      error.code === "invalid-result"
    ) {
      return storageCorruption(collections);
    }
    throw error;
  }
};

const validateRunnerInput = (input: RunFirebaseInsightsJobInput): number => {
  try {
    assertInsightsMaintenanceInputContract(input);
  } catch {
    return invalidQuery();
  }
  if (
    typeof input.jobId !== "string" ||
    input.jobId.length === 0 ||
    !isTimestamp(input.nowMs)
  ) {
    return invalidQuery();
  }
  return input.maxItems;
};

const workId = (jobId: string, parts: readonly unknown[]): string =>
  firebaseEventScopeKey(canonicalInsightsJson([jobId, ...parts]));

const padded = (value: number): string => value.toString().padStart(16, "0");

type WorkWrite = { readonly id: string; readonly data: DocumentData };

const stringOrderParts = (value: string): readonly [string, string, string] => {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return [
    encoded.slice(0, 1_368),
    encoded.slice(1_368, 2_736),
    encoded.slice(2_736),
  ];
};

const inverseCount = (value: number): string =>
  padded(Number.MAX_SAFE_INTEGER - value);

const aggregateSortFields = (
  sectionKey: string,
  sort: readonly unknown[],
  rankedCount?: number,
) => {
  let parts = ["", "", "", "", ""];
  if (
    sectionKey.startsWith("movementSeries:") ||
    sectionKey === "activeSeries"
  ) {
    parts[0] = String(sort[0]);
  } else if (sectionKey.startsWith("movementCohorts:")) {
    parts = [...stringOrderParts(String(sort[0])), "", ""];
  } else if (sectionKey === "bundleDistribution") {
    if (!isTimestamp(rankedCount)) return invalidResult();
    parts = [
      inverseCount(rankedCount),
      ...stringOrderParts(String(sort[0])),
      "",
    ];
  } else if (sectionKey === "activeBundleSeries") {
    if (!isTimestamp(rankedCount)) return invalidResult();
    parts = [
      inverseCount(rankedCount),
      ...stringOrderParts(String(sort[0])),
      String(sort[1]),
    ];
  } else {
    parts[0] = firebaseEventScopeKey(canonicalInsightsJson(sort));
  }
  return {
    sortSection: sectionKey,
    sort0: parts[0],
    sort1: parts[1],
    sort2: parts[2],
    sort3: parts[3],
    sort4: parts[4],
  };
};

const aggregateOrderKey = (
  sectionKey: string,
  sort: readonly unknown[],
): string => {
  if (
    sectionKey.startsWith("movementSeries:") ||
    sectionKey === "activeSeries"
  ) {
    return `${sectionKey}:${String(sort[0])}`;
  }
  if (sectionKey === "activeBundleSeries") {
    return `${sectionKey}:${firebaseEventScopeKey(String(sort[0]))}:${String(sort[1])}`;
  }
  return `${sectionKey}:${firebaseEventScopeKey(canonicalInsightsJson(sort))}`;
};

const aggregateMember = (
  jobId: string,
  sectionKey: string,
  sort: readonly unknown[],
  installId: string,
  row: DocumentData,
): WorkWrite => {
  const aggregateKey = aggregateOrderKey(sectionKey, sort);
  const installKey = firebaseInstallationKey(installId);
  return {
    id: workId(jobId, ["member", aggregateKey, installKey]),
    data: {
      jobId,
      recordKind: "aggregateMember",
      aggregateKey,
      sectionKey,
      orderKey: aggregateKey,
      ...aggregateSortFields(sectionKey, sort),
      installKey,
      row,
    },
  };
};

const rankedAggregateMember = (
  jobId: string,
  sectionKey: "activeBundleSeries" | "bundleDistribution",
  sort: readonly unknown[],
  row: DocumentData,
  weight: number,
  rankedCount = weight,
): WorkWrite => {
  if (!isTimestamp(weight) || !isTimestamp(rankedCount)) {
    return invalidResult();
  }
  const aggregateKey = aggregateOrderKey(sectionKey, sort);
  return {
    id: workId(jobId, ["ranked", aggregateKey]),
    data: {
      jobId,
      recordKind: "aggregateMember",
      aggregateKey,
      sectionKey,
      orderKey: aggregateKey,
      ...aggregateSortFields(sectionKey, sort, rankedCount),
      installKey: "ranked",
      weight,
      row,
    },
  };
};

const movementWrites = (
  job: DocumentData,
  event: BundleEventRow,
): readonly WorkWrite[] => {
  const projection = createInsightsReportProjection(
    job.query,
    job.asOfMs,
  ).project(event);
  if (projection?.kind !== "movement") return [];
  const writes = [
    aggregateMember(
      job.id,
      `summary:${projection.metric}`,
      [projection.bundleId],
      projection.installId,
      { bundleId: projection.bundleId, metric: projection.metric },
    ),
  ];
  if (job.query.kind === "bundleDetail") {
    writes.push(
      aggregateMember(
        job.id,
        `movementSeries:${projection.metric}`,
        [padded(projection.bucketStartMs)],
        projection.installId,
        { bucketStartMs: projection.bucketStartMs },
      ),
      aggregateMember(
        job.id,
        `movementCohorts:${projection.metric}`,
        [projection.cohort],
        projection.installId,
        { cohort: projection.cohort },
      ),
    );
  }
  return writes;
};

const isLater = (left: BundleEventRow, right: BundleEventRow): boolean =>
  left.received_at_ms > right.received_at_ms ||
  (left.received_at_ms === right.received_at_ms && left.id > right.id);

const reportScanStep = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  jobId: string,
  maxItems: number,
  meter: FirebaseInsightsJobUsageMeter,
): Promise<FirebaseInsightsJobStepResult> =>
  runMeasuredTransaction(
    db,
    meter,
    async (transaction): Promise<FirebaseInsightsJobStepResult> => {
      const jobRef = collections.jobs.doc(jobId);
      const jobDocument = await transaction.get(jobRef);
      const job = assertJobDocument(jobDocument.data(), jobId);
      if (job.state !== "building" || job.phase !== "scan")
        return invalidResult();
      if (
        !Array.isArray(job.upperSequences) ||
        job.upperSequences.length !== SOURCE_IDS.length ||
        !Number.isSafeInteger(job.sourceIndex) ||
        !isTimestamp(job.afterSequence) ||
        !isTimestamp(job.asOfMs)
      )
        return invalidResult();
      let sourceIndex = job.sourceIndex as number;
      while (
        sourceIndex < SOURCE_IDS.length &&
        job.upperSequences[sourceIndex] === 0
      ) {
        sourceIndex += 1;
      }
      if (sourceIndex >= SOURCE_IDS.length) {
        const nextPhase =
          job.query.kind === "activeOverview" ||
          job.query.kind === "installationOverview"
            ? "transformLatest"
            : job.query.kind === "bundleDetail"
              ? "seedSeries"
              : "reduce";
        transaction.update(jobRef, {
          phase: nextPhase,
          sourceIndex,
          afterSequence: 0,
          afterKey: null,
          revision: job.revision + 1,
        });
        return { state: "building", phase: nextPhase, processed: 0 };
      }
      const upper = job.upperSequences[sourceIndex];
      if (!isTimestamp(upper)) return invalidResult();
      const sourceShard = sourceShardValue(sourceIndex);
      const candidates = await transaction.get(
        collections.events
          .where("_insights_source_shard", "==", sourceShard)
          .where("_insights_source_seq", ">", job.afterSequence)
          .where("_insights_source_seq", "<=", upper)
          .orderBy("_insights_source_seq", "asc")
          .limit(maxItems + 1),
      );
      const documents = candidates.docs.slice(0, maxItems);
      const events = documents.map((document) => {
        const event = readStoredEvent(document.data(), document.ref.path);
        if (
          document.id !== firebaseEventDocumentId(event.id) ||
          document.data()._insights_source_shard !== sourceShard
        )
          return invalidResult();
        return {
          event,
          sequence: readSequence({
            sequence: document.data()._insights_source_seq,
          }),
        };
      });
      const sourceComplete = candidates.size <= maxItems;
      assertContiguousSourceBatch(
        events.map(({ sequence }) => sequence),
        job.afterSequence,
        upper,
        sourceComplete,
      );
      if (
        getCanonicalInsightsJsonByteLength(events.map(({ event }) => event)) >
        INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
      )
        return invalidResult();
      const work = new Map<string, WorkWrite>();
      let minMovementBucket = isTimestamp(job.minMovementBucket)
        ? job.minMovementBucket
        : null;
      if (
        job.query.kind === "bundleSummaries" ||
        job.query.kind === "bundleDetail"
      ) {
        for (const { event } of events) {
          for (const item of movementWrites(job, event)) {
            work.set(item.id, item);
            if (
              item.data.sectionKey?.startsWith("movementSeries:") &&
              isTimestamp(item.data.row?.bucketStartMs)
            ) {
              minMovementBucket =
                minMovementBucket === null
                  ? item.data.row.bucketStartMs
                  : Math.min(minMovementBucket, item.data.row.bucketStartMs);
            }
          }
        }
      } else {
        for (const { event } of events) {
          const projection = createInsightsReportProjection(
            job.query,
            job.asOfMs,
          ).project(event);
          if (projection?.kind !== "installation") continue;
          const installKey = firebaseInstallationKey(event.install_id);
          const latestId = workId(jobId, ["installLatest", installKey]);
          const batchLatest = work.get(latestId);
          if (
            batchLatest === undefined ||
            isLater(event, batchLatest.data.row)
          ) {
            work.set(latestId, {
              id: latestId,
              data: {
                jobId,
                recordKind: "installLatest",
                orderKey: installKey,
                installKey,
                row: event,
              },
            });
          }
          if (job.query.kind === "activeOverview") {
            const bucketKey = `${installKey}:${padded(projection.bucketStartMs!)}`;
            const bucketId = workId(jobId, ["bucketLatest", bucketKey]);
            const batchBucket = work.get(bucketId);
            if (
              batchBucket === undefined ||
              isLater(event, batchBucket.data.row)
            ) {
              work.set(bucketId, {
                id: bucketId,
                data: {
                  jobId,
                  recordKind: "bucketLatest",
                  orderKey: bucketKey,
                  installKey,
                  bucketStartMs: projection.bucketStartMs,
                  row: event,
                },
              });
            }
          }
        }
      }
      const refs = [...work.values()].map((item) =>
        collections.work.doc(item.id),
      );
      const existing = refs.length ? await transaction.getAll(...refs) : [];
      if (
        getCanonicalInsightsJsonByteLength([
          ...events.map(({ event }) => event),
          ...existing
            .filter((document) => document.exists)
            .map((document) => document.data()),
        ]) > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
      ) {
        return invalidResult();
      }
      existing.forEach((document) => {
        if (!document.exists) return;
        const item = work.get(document.id)!;
        if (
          item.data.recordKind === "aggregateMember" ||
          isLater(
            readStoredEvent(document.data()!.row, document.ref.path),
            item.data.row,
          )
        ) {
          work.delete(document.id);
        }
      });
      for (const item of work.values())
        transaction.set(collections.work.doc(item.id), item.data);
      const afterSequence = events.at(-1)?.sequence ?? job.afterSequence;
      let nextSourceIndex = sourceComplete ? sourceIndex + 1 : sourceIndex;
      while (
        nextSourceIndex < SOURCE_IDS.length &&
        job.upperSequences[nextSourceIndex] === 0
      ) {
        nextSourceIndex += 1;
      }
      const scanComplete = nextSourceIndex >= SOURCE_IDS.length;
      const nextPhase = scanComplete
        ? job.query.kind === "activeOverview" ||
          job.query.kind === "installationOverview"
          ? "transformLatest"
          : job.query.kind === "bundleDetail"
            ? "seedSeries"
            : "reduce"
        : "scan";
      transaction.update(jobRef, {
        phase: nextPhase,
        sourceIndex: nextSourceIndex,
        afterSequence: sourceComplete ? 0 : afterSequence,
        afterKey: null,
        minMovementBucket,
        seedNextBucket: null,
        revision: job.revision + 1,
      });
      return { state: "building", phase: nextPhase, processed: events.length };
    },
    { maxAttempts: 1 },
  );

const transformLatestStep = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  jobId: string,
  maxItems: number,
  meter: FirebaseInsightsJobUsageMeter,
): Promise<FirebaseInsightsJobStepResult> =>
  runMeasuredTransaction(
    db,
    meter,
    async (transaction): Promise<FirebaseInsightsJobStepResult> => {
      const jobRef = collections.jobs.doc(jobId);
      const jobDocument = await transaction.get(jobRef);
      const job = assertJobDocument(jobDocument.data(), jobId);
      if (job.state !== "building" || job.phase !== "transformLatest")
        return invalidResult();
      let query = collections.work
        .where("jobId", "==", jobId)
        .where("recordKind", "==", "installLatest")
        .orderBy("orderKey", "asc");
      if (typeof job.afterKey === "string")
        query = query.startAfter(job.afterKey);
      const candidates = await transaction.get(query.limit(maxItems + 1));
      const documents = candidates.docs.slice(0, maxItems);
      const qualified = documents.flatMap((document) => {
        const value = document.data();
        const event = readStoredEvent(value.row, document.ref.path);
        assertFirebaseInstallationIdentity(
          event.install_id,
          value.installKey,
          event.install_id,
        );
        if (
          job.query.kind === "activeOverview" &&
          job.query.userId !== undefined &&
          event.user_id !== job.query.userId
        ) {
          return [];
        }
        return [{ event, installKey: value.installKey as string }];
      });
      const distribution = new Map<
        string,
        { bundleId: string; count: number }
      >();
      for (const { event } of qualified) {
        const orderKey = firebaseEventScopeKey(event.to_bundle_id);
        const saved = distribution.get(orderKey);
        if (saved !== undefined && saved.bundleId !== event.to_bundle_id) {
          return invalidResult();
        }
        distribution.set(orderKey, {
          bundleId: event.to_bundle_id,
          count: (saved?.count ?? 0) + 1,
        });
      }
      const distributionRefs = [...distribution.keys()].map((orderKey) =>
        collections.work.doc(workId(jobId, ["distributionBundle", orderKey])),
      );
      const priorDistribution = distributionRefs.length
        ? await transaction.getAll(...distributionRefs)
        : [];
      priorDistribution.forEach((document, index) => {
        if (!document.exists) return;
        const saved = document.data()!;
        const item = distribution.get([...distribution.keys()][index]!)!;
        if (
          !isRecord(saved.row) ||
          saved.row.bundleId !== item.bundleId ||
          !isTimestamp(saved.total)
        ) {
          return invalidResult();
        }
        item.count += saved.total;
      });
      for (const { event, installKey } of qualified) {
        const summaryKey =
          job.query.kind === "activeOverview"
            ? "summary:active"
            : "summary:tracked";
        const summary = aggregateMember(
          jobId,
          summaryKey,
          [],
          event.install_id,
          {},
        );
        transaction.set(collections.work.doc(summary.id), summary.data);
        if (job.query.kind === "activeOverview") {
          transaction.set(
            collections.work.doc(workId(jobId, ["qualified", installKey])),
            {
              jobId,
              recordKind: "qualified",
              orderKey: installKey,
              installKey,
            },
          );
        }
      }
      [...distribution.entries()].forEach(([orderKey, item], index) => {
        const [label0, label1, label2] = stringOrderParts(item.bundleId);
        transaction.set(distributionRefs[index]!, {
          jobId,
          recordKind: "distributionBundle",
          orderKey,
          label0,
          label1,
          label2,
          total: item.count,
          row: { bundleId: item.bundleId },
        });
      });
      const complete = candidates.size <= maxItems;
      const nextPhase = complete ? "seedDistribution" : "transformLatest";
      transaction.update(jobRef, {
        phase: nextPhase,
        afterKey: complete ? null : documents.at(-1)!.data().orderKey,
        revision: job.revision + 1,
      });
      return {
        state: "building",
        phase: nextPhase,
        processed: documents.length,
      };
    },
    { maxAttempts: 1 },
  );

const seedDistributionStep = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  jobId: string,
  maxItems: number,
  meter: FirebaseInsightsJobUsageMeter,
): Promise<FirebaseInsightsJobStepResult> =>
  runMeasuredTransaction(
    db,
    meter,
    async (transaction): Promise<FirebaseInsightsJobStepResult> => {
      const jobRef = collections.jobs.doc(jobId);
      const jobDocument = await transaction.get(jobRef);
      const job = assertJobDocument(jobDocument.data(), jobId);
      if (job.state !== "building" || job.phase !== "seedDistribution") {
        return invalidResult();
      }
      let query = collections.work
        .where("jobId", "==", jobId)
        .where("recordKind", "==", "distributionBundle")
        .orderBy("total", "desc")
        .orderBy("label0", "asc")
        .orderBy("label1", "asc")
        .orderBy("label2", "asc")
        .orderBy("orderKey", "asc");
      if (
        isTimestamp(job.distributionAfterTotal) &&
        typeof job.distributionAfterLabel0 === "string" &&
        typeof job.distributionAfterLabel1 === "string" &&
        typeof job.distributionAfterLabel2 === "string" &&
        typeof job.afterKey === "string"
      ) {
        query = query.startAfter(
          job.distributionAfterTotal,
          job.distributionAfterLabel0,
          job.distributionAfterLabel1,
          job.distributionAfterLabel2,
          job.afterKey,
        );
      }
      const candidates = await transaction.get(query.limit(maxItems + 1));
      const documents = candidates.docs.slice(0, maxItems);
      for (const document of documents) {
        const value = document.data();
        if (
          !isRecord(value.row) ||
          typeof value.row.bundleId !== "string" ||
          !isTimestamp(value.total)
        ) {
          return invalidResult();
        }
        const member = rankedAggregateMember(
          jobId,
          "bundleDistribution",
          [value.row.bundleId],
          { bundleId: value.row.bundleId },
          value.total,
        );
        transaction.set(collections.work.doc(member.id), member.data);
      }
      const complete = candidates.size <= maxItems;
      const last = documents.at(-1)?.data();
      const nextPhase = complete
        ? job.query.kind === "activeOverview"
          ? "transformBuckets"
          : "reduce"
        : "seedDistribution";
      transaction.update(jobRef, {
        phase: nextPhase,
        distributionAfterTotal: complete ? null : last!.total,
        distributionAfterLabel0: complete ? null : last!.label0,
        distributionAfterLabel1: complete ? null : last!.label1,
        distributionAfterLabel2: complete ? null : last!.label2,
        afterKey: complete ? null : last!.orderKey,
        revision: job.revision + 1,
      });
      return {
        state: "building",
        phase: nextPhase,
        processed: documents.length,
      };
    },
    { maxAttempts: 1 },
  );

const transformBucketsStep = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  jobId: string,
  maxItems: number,
  meter: FirebaseInsightsJobUsageMeter,
): Promise<FirebaseInsightsJobStepResult> =>
  runMeasuredTransaction(
    db,
    meter,
    async (transaction): Promise<FirebaseInsightsJobStepResult> => {
      const jobRef = collections.jobs.doc(jobId);
      const jobDocument = await transaction.get(jobRef);
      const job = assertJobDocument(jobDocument.data(), jobId);
      if (job.state !== "building" || job.phase !== "transformBuckets")
        return invalidResult();
      let query = collections.work
        .where("jobId", "==", jobId)
        .where("recordKind", "==", "bucketLatest")
        .orderBy("orderKey", "asc");
      if (typeof job.afterKey === "string")
        query = query.startAfter(job.afterKey);
      const candidates = await transaction.get(query.limit(maxItems + 1));
      const documents = candidates.docs.slice(0, maxItems);
      const owners = documents.map((document) =>
        collections.work.doc(
          workId(jobId, ["qualified", document.data().installKey]),
        ),
      );
      const ownerDocuments = owners.length
        ? await transaction.getAll(...owners)
        : [];
      const qualified: {
        event: BundleEventRow;
        bucketStartMs: number;
      }[] = [];
      for (let index = 0; index < documents.length; index += 1) {
        if (!ownerDocuments[index]!.exists) continue;
        const value = documents[index]!.data();
        const event = readStoredEvent(value.row, documents[index]!.ref.path);
        const bucketStartMs = value.bucketStartMs;
        if (!isTimestamp(bucketStartMs)) return invalidResult();
        qualified.push({ event, bucketStartMs });
      }
      const bundles = new Map<
        string,
        {
          bundleId: string;
          total: number;
          bucketCounts: Record<string, number>;
        }
      >();
      for (const { event, bucketStartMs } of qualified) {
        const bundleOrderKey = firebaseEventScopeKey(event.to_bundle_id);
        const saved = bundles.get(bundleOrderKey);
        if (saved !== undefined && saved.bundleId !== event.to_bundle_id) {
          return invalidResult();
        }
        const item = saved ?? {
          bundleId: event.to_bundle_id,
          total: 0,
          bucketCounts: {},
        };
        const bucketKey = padded(bucketStartMs);
        item.total += 1;
        item.bucketCounts[bucketKey] = (item.bucketCounts[bucketKey] ?? 0) + 1;
        bundles.set(bundleOrderKey, item);
      }
      const bundleEntries = [...bundles.entries()];
      const bundleRefs = bundleEntries.map(([bundleOrderKey]) =>
        collections.work.doc(workId(jobId, ["activeBundle", bundleOrderKey])),
      );
      const priorBundles = bundleRefs.length
        ? await transaction.getAll(...bundleRefs)
        : [];
      priorBundles.forEach((document, index) => {
        if (!document.exists) return;
        const value = document.data()!;
        const item = bundleEntries[index]![1];
        if (
          !isRecord(value.row) ||
          value.row.bundleId !== item.bundleId ||
          !isTimestamp(value.total) ||
          !isRecord(value.bucketCounts)
        ) {
          return invalidResult();
        }
        item.total += value.total;
        for (const [bucketKey, count] of Object.entries(value.bucketCounts)) {
          if (!/^\d{16}$/.test(bucketKey) || !isTimestamp(count)) {
            return invalidResult();
          }
          item.bucketCounts[bucketKey] =
            (item.bucketCounts[bucketKey] ?? 0) + count;
        }
      });
      for (const { event, bucketStartMs } of qualified) {
        const item = aggregateMember(
          jobId,
          "activeSeries",
          [padded(bucketStartMs)],
          event.install_id,
          { bucketStartMs },
        );
        transaction.set(collections.work.doc(item.id), item.data);
      }
      bundleEntries.forEach(([bundleOrderKey, item], index) => {
        const [label0, label1, label2] = stringOrderParts(item.bundleId);
        transaction.set(bundleRefs[index]!, {
          jobId,
          recordKind: "activeBundle",
          orderKey: bundleOrderKey,
          label0,
          label1,
          label2,
          total: item.total,
          bucketCounts: item.bucketCounts,
          row: { bundleId: item.bundleId },
        });
      });
      const complete = candidates.size <= maxItems;
      const nextPhase = complete ? "seedSeries" : "transformBuckets";
      transaction.update(jobRef, {
        phase: nextPhase,
        afterKey: complete ? null : documents.at(-1)!.data().orderKey,
        afterDocumentId: null,
        seedNextBucket: null,
        revision: job.revision + 1,
      });
      return {
        state: "building",
        phase: nextPhase,
        processed: documents.length,
      };
    },
    { maxAttempts: 1 },
  );

const zeroMember = (
  jobId: string,
  sectionKey: string,
  bucketStartMs: number,
): WorkWrite => {
  const aggregateKey = aggregateOrderKey(sectionKey, [padded(bucketStartMs)]);
  return {
    id: workId(jobId, ["zero", aggregateKey]),
    data: {
      jobId,
      recordKind: "aggregateMember",
      aggregateKey,
      sectionKey,
      orderKey: aggregateKey,
      ...aggregateSortFields(sectionKey, [padded(bucketStartMs)]),
      installKey: "zero",
      weight: 0,
      row: { bucketStartMs },
    },
  };
};

const seedSeriesStep = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  jobId: string,
  maxItems: number,
  meter: FirebaseInsightsJobUsageMeter,
): Promise<FirebaseInsightsJobStepResult> =>
  runMeasuredTransaction(
    db,
    meter,
    async (transaction): Promise<FirebaseInsightsJobStepResult> => {
      const jobRef = collections.jobs.doc(jobId);
      const jobDocument = await transaction.get(jobRef);
      const job = assertJobDocument(jobDocument.data(), jobId);
      if (job.state !== "building" || job.phase !== "seedSeries") {
        return invalidResult();
      }
      const projection = createInsightsReportProjection(job.query, job.asOfMs);
      const sections =
        job.query.kind === "bundleDetail"
          ? ["movementSeries:installed", "movementSeries:recovered"]
          : job.query.kind === "activeOverview"
            ? ["activeSeries"]
            : [];
      const first =
        job.query.kind === "bundleDetail" && projection.firstBucketMs === null
          ? job.minMovementBucket
          : projection.firstBucketMs;
      const next = isTimestamp(job.seedNextBucket) ? job.seedNextBucket : first;
      if (!isTimestamp(next) || sections.length === 0) {
        transaction.update(jobRef, {
          phase: "reduce",
          afterKey: null,
          afterDocumentId: null,
          revision: job.revision + 1,
        });
        return { state: "building", phase: "reduce", processed: 0 };
      }
      const bucketsPerStep = Math.max(
        1,
        Math.floor(maxItems / sections.length),
      );
      let bucket = next;
      let processed = 0;
      while (bucket <= projection.lastBucketMs && processed < bucketsPerStep) {
        for (const section of sections) {
          const item = zeroMember(jobId, section, bucket);
          transaction.set(collections.work.doc(item.id), item.data);
        }
        bucket += projection.bucketSizeMs;
        processed += 1;
      }
      const complete = bucket > projection.lastBucketMs;
      transaction.update(jobRef, {
        phase: complete
          ? job.query.kind === "activeOverview"
            ? "seedActiveBundles"
            : "reduce"
          : "seedSeries",
        seedNextBucket: complete ? null : bucket,
        afterKey: null,
        afterDocumentId: null,
        revision: job.revision + 1,
      });
      return {
        state: "building",
        phase: complete
          ? job.query.kind === "activeOverview"
            ? "seedActiveBundles"
            : "reduce"
          : "seedSeries",
        processed,
      };
    },
    { maxAttempts: 1 },
  );

const seedActiveBundlesStep = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  jobId: string,
  maxItems: number,
  meter: FirebaseInsightsJobUsageMeter,
): Promise<FirebaseInsightsJobStepResult> =>
  runMeasuredTransaction(
    db,
    meter,
    async (transaction): Promise<FirebaseInsightsJobStepResult> => {
      const jobRef = collections.jobs.doc(jobId);
      const jobDocument = await transaction.get(jobRef);
      const job = assertJobDocument(jobDocument.data(), jobId);
      if (
        job.state !== "building" ||
        job.phase !== "seedActiveBundles" ||
        job.query.kind !== "activeOverview"
      ) {
        return invalidResult();
      }
      const projection = createInsightsReportProjection(job.query, job.asOfMs);
      let bundleId =
        typeof job.seedBundleId === "string" ? job.seedBundleId : null;
      let bundleOrderKey =
        typeof job.seedBundleOrderKey === "string"
          ? job.seedBundleOrderKey
          : null;
      let bucket = isTimestamp(job.seedNextBucket)
        ? job.seedNextBucket
        : projection.firstBucketMs;
      let bundleDocument;
      if (bundleId !== null && bundleOrderKey !== null) {
        bundleDocument = await transaction.get(
          collections.work.doc(workId(jobId, ["activeBundle", bundleOrderKey])),
        );
      } else {
        let query = collections.work
          .where("jobId", "==", jobId)
          .where("recordKind", "==", "activeBundle")
          .orderBy("total", "desc")
          .orderBy("label0", "asc")
          .orderBy("label1", "asc")
          .orderBy("label2", "asc")
          .orderBy("orderKey", "asc");
        if (
          isTimestamp(job.seedBundleAfterTotal) &&
          typeof job.seedBundleAfterLabel0 === "string" &&
          typeof job.seedBundleAfterLabel1 === "string" &&
          typeof job.seedBundleAfterLabel2 === "string" &&
          typeof job.seedBundleAfterKey === "string"
        ) {
          query = query.startAfter(
            job.seedBundleAfterTotal,
            job.seedBundleAfterLabel0,
            job.seedBundleAfterLabel1,
            job.seedBundleAfterLabel2,
            job.seedBundleAfterKey,
          );
        }
        const bundle = await transaction.get(query.limit(1));
        if (bundle.empty) {
          transaction.update(jobRef, {
            phase: "reduce",
            seedBundleId: null,
            seedBundleOrderKey: null,
            seedNextBucket: null,
            afterKey: null,
            afterDocumentId: null,
            revision: job.revision + 1,
          });
          return { state: "building", phase: "reduce", processed: 0 };
        }
        bundleDocument = bundle.docs[0]!;
        bucket = projection.firstBucketMs;
      }
      if (!bundleDocument.exists) return invalidResult();
      const value = bundleDocument.data()!;
      if (
        !isRecord(value.row) ||
        typeof value.row.bundleId !== "string" ||
        typeof value.orderKey !== "string" ||
        value.orderKey !== firebaseEventScopeKey(value.row.bundleId) ||
        !isTimestamp(value.total) ||
        !isRecord(value.bucketCounts) ||
        typeof value.label0 !== "string" ||
        typeof value.label1 !== "string" ||
        typeof value.label2 !== "string"
      ) {
        return invalidResult();
      }
      bundleId = value.row.bundleId;
      bundleOrderKey = value.orderKey;
      if (!isTimestamp(bucket)) return invalidResult();
      let processed = 0;
      while (bucket <= projection.lastBucketMs && processed < maxItems) {
        const count = value.bucketCounts[padded(bucket)] ?? 0;
        if (!isTimestamp(count)) return invalidResult();
        const item = rankedAggregateMember(
          jobId,
          "activeBundleSeries",
          [bundleId, padded(bucket)],
          { bundleId, bucketStartMs: bucket },
          count,
          value.total,
        );
        transaction.set(collections.work.doc(item.id), item.data);
        bucket += projection.bucketSizeMs;
        processed += 1;
      }
      const bundleComplete = bucket > projection.lastBucketMs;
      transaction.update(jobRef, {
        seedBundleId: bundleComplete ? null : bundleId,
        seedBundleOrderKey: bundleComplete ? null : bundleOrderKey,
        seedBundleAfterKey: bundleComplete
          ? bundleOrderKey
          : (job.seedBundleAfterKey ?? null),
        seedBundleAfterTotal: bundleComplete
          ? value.total
          : (job.seedBundleAfterTotal ?? null),
        seedBundleAfterLabel0: bundleComplete
          ? value.label0
          : (job.seedBundleAfterLabel0 ?? null),
        seedBundleAfterLabel1: bundleComplete
          ? value.label1
          : (job.seedBundleAfterLabel1 ?? null),
        seedBundleAfterLabel2: bundleComplete
          ? value.label2
          : (job.seedBundleAfterLabel2 ?? null),
        seedNextBucket: bundleComplete ? null : bucket,
        revision: job.revision + 1,
      });
      return {
        state: "building",
        phase: "seedActiveBundles",
        processed,
      };
    },
    { maxAttempts: 1 },
  );

const summaryFromEntries = (
  job: DocumentData,
  entries: readonly DocumentData[],
) => {
  if (job.query.kind === "bundleSummaries") {
    const counts = new Map<string, { installed: number; recovered: number }>();
    for (const bundleId of job.query.bundleIds as string[])
      counts.set(bundleId, { installed: 0, recovered: 0 });
    for (const entry of entries) {
      const value = counts.get(entry.row.bundleId);
      if (value)
        value[entry.row.metric as "installed" | "recovered"] = entry.count;
    }
    return [...counts].map(([bundleId, value]) => ({ bundleId, ...value }));
  }
  if (job.query.kind === "bundleDetail") {
    const summary = { installed: 0, recovered: 0 };
    for (const entry of entries)
      summary[entry.row.metric as "installed" | "recovered"] = entry.count;
    return summary;
  }
  const key =
    job.query.kind === "activeOverview" ? "summary:active" : "summary:tracked";
  const count = entries.find((entry) => entry.sectionKey === key)?.count ?? 0;
  return job.query.kind === "activeOverview"
    ? { activeInstallations: count }
    : { trackedInstallations: count };
};

const outputRow = (value: DocumentData) => {
  if (value.sectionKey.startsWith("movementSeries:"))
    return { bucketStartMs: value.row.bucketStartMs, value: value.count };
  if (value.sectionKey.startsWith("movementCohorts:"))
    return { cohort: value.row.cohort, value: value.count };
  if (value.sectionKey === "bundleDistribution")
    return { bundleId: value.row.bundleId, installations: value.count };
  if (value.sectionKey === "activeSeries")
    return { bucketStartMs: value.row.bucketStartMs, value: value.count };
  if (value.sectionKey === "activeBundleSeries")
    return {
      bundleId: value.row.bundleId,
      bucketStartMs: value.row.bucketStartMs,
      value: value.count,
    };
  return null;
};

const reduceStep = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  jobId: string,
  maxItems: number,
  nowMs: number,
  meter: FirebaseInsightsJobUsageMeter,
): Promise<FirebaseInsightsJobStepResult> =>
  runMeasuredTransaction(
    db,
    meter,
    async (transaction): Promise<FirebaseInsightsJobStepResult> => {
      const jobRef = collections.jobs.doc(jobId);
      const jobDocument = await transaction.get(jobRef);
      const job = assertJobDocument(jobDocument.data(), jobId);
      if (job.state !== "building" || job.phase !== "reduce")
        return invalidResult();
      let query = collections.work
        .where("jobId", "==", jobId)
        .where("recordKind", "==", "aggregateMember")
        .orderBy("sortSection", "asc")
        .orderBy("sort0", "asc")
        .orderBy("sort1", "asc")
        .orderBy("sort2", "asc")
        .orderBy("sort3", "asc")
        .orderBy("sort4", "asc")
        .orderBy("aggregateKey", "asc")
        .orderBy(FieldPath.documentId(), "asc");
      if (
        typeof job.reduceAfterSection === "string" &&
        typeof job.reduceAfterSort0 === "string" &&
        typeof job.reduceAfterSort1 === "string" &&
        typeof job.reduceAfterSort2 === "string" &&
        typeof job.reduceAfterSort3 === "string" &&
        typeof job.reduceAfterSort4 === "string" &&
        typeof job.afterKey === "string" &&
        typeof job.afterDocumentId === "string"
      ) {
        query = query.startAfter(
          job.reduceAfterSection,
          job.reduceAfterSort0,
          job.reduceAfterSort1,
          job.reduceAfterSort2,
          job.reduceAfterSort3,
          job.reduceAfterSort4,
          job.afterKey,
          job.afterDocumentId,
        );
      }
      const candidates = await transaction.get(query.limit(maxItems + 1));
      if (
        getCanonicalInsightsJsonByteLength(
          candidates.docs.map((document) => document.data()),
        ) > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
      ) {
        return invalidResult();
      }
      const documents = candidates.docs.slice(0, maxItems);
      let current = isRecord(job.reduceCurrent)
        ? { ...job.reduceCurrent }
        : null;
      const outputs: DocumentData[] = [];
      for (const document of documents) {
        const value = document.data();
        if (
          typeof value.aggregateKey !== "string" ||
          typeof value.sectionKey !== "string" ||
          typeof value.sortSection !== "string" ||
          typeof value.sort0 !== "string" ||
          typeof value.sort1 !== "string" ||
          typeof value.sort2 !== "string" ||
          typeof value.sort3 !== "string" ||
          typeof value.sort4 !== "string" ||
          !isRecord(value.row)
        )
          return invalidResult();
        if (current === null) {
          current = {
            aggregateKey: value.aggregateKey,
            sectionKey: value.sectionKey,
            row: value.row,
            count: 0,
          };
        } else if (current.aggregateKey !== value.aggregateKey) {
          outputs.push(current);
          current = {
            aggregateKey: value.aggregateKey,
            sectionKey: value.sectionKey,
            row: value.row,
            count: 0,
          };
        } else if (
          canonicalInsightsJson(current.row) !==
          canonicalInsightsJson(value.row)
        ) {
          return invalidResult();
        }
        const weight = value.weight === undefined ? 1 : value.weight;
        if (!isTimestamp(weight)) return invalidResult();
        current.count += weight;
        if (!Number.isSafeInteger(current.count)) return invalidResult();
      }
      const complete = candidates.size <= maxItems;
      if (complete && current !== null) {
        outputs.push(current);
        current = null;
      }
      const rowOutputs = outputs.filter((value) => outputRow(value) !== null);
      const countDeltas = new Map<
        string,
        {
          sectionKey: string;
          bundleKey?: string;
          bundleId?: string;
          value: number;
        }
      >();
      for (const value of rowOutputs) {
        const scopes: {
          sectionKey: string;
          bundleKey?: string;
          bundleId?: string;
        }[] = [{ sectionKey: value.sectionKey as string }];
        if (value.sectionKey === "activeBundleSeries") {
          scopes.push({
            sectionKey: value.sectionKey,
            bundleKey: firebaseEventScopeKey(value.row.bundleId),
            bundleId: value.row.bundleId,
          });
        }
        for (const scope of scopes) {
          const id = reportCountId(jobId, scope.sectionKey, scope.bundleKey);
          const saved = countDeltas.get(id);
          if (
            saved !== undefined &&
            (saved.bundleKey !== scope.bundleKey ||
              saved.bundleId !== scope.bundleId)
          ) {
            return invalidResult();
          }
          countDeltas.set(id, { ...scope, value: (saved?.value ?? 0) + 1 });
        }
      }
      const sectionKeys = reportSectionManifestKeys(job.query);
      const countScopes = new Map(countDeltas);
      if (complete) {
        for (const sectionKey of sectionKeys) {
          const id = reportCountId(jobId, sectionKey);
          if (!countScopes.has(id)) {
            countScopes.set(id, { sectionKey, value: 0 });
          }
        }
      }
      const countRefs = [...countScopes.keys()].map((id) =>
        collections.reportCounts.doc(id),
      );
      const countDocuments = countRefs.length
        ? await transaction.getAll(...countRefs)
        : [];
      const priorCounts = new Map<string, number>();
      countDocuments.forEach((document) => {
        const scope = countScopes.get(document.id)!;
        if (
          document.exists &&
          (document.data()?.publicationId !== jobId ||
            document.data()?.sectionKey !== scope.sectionKey ||
            document.data()?.bundleKey !== scope.bundleKey ||
            document.data()?.bundleId !== scope.bundleId ||
            (scope.bundleKey !== undefined &&
              !hasBundleIdentity(scope.bundleKey, scope.bundleId)))
        ) {
          return invalidResult();
        }
        priorCounts.set(
          document.id,
          document.exists ? readSequence(document.data()) : 0,
        );
      });
      const headDocument = complete
        ? await transaction.get(collections.heads.doc(job.headId))
        : null;
      if (
        headDocument !== null &&
        headDocument.data()?.currentJobId !== jobId
      ) {
        return invalidResult();
      }
      const offsets = new Map<string, number>();
      for (const value of rowOutputs) {
        const sectionKey = value.sectionKey as string;
        const mainId = reportCountId(jobId, sectionKey);
        const ordinal =
          (priorCounts.get(mainId) ?? 0) + (offsets.get(mainId) ?? 0);
        offsets.set(mainId, (offsets.get(mainId) ?? 0) + 1);
        const row = outputRow(value)!;
        const bundleKey =
          sectionKey === "activeBundleSeries"
            ? firebaseEventScopeKey(value.row.bundleId)
            : undefined;
        const bundleId =
          bundleKey === undefined
            ? undefined
            : reportCountId(jobId, sectionKey, bundleKey);
        const bundleOrdinal =
          bundleId === undefined
            ? undefined
            : (priorCounts.get(bundleId) ?? 0) + (offsets.get(bundleId) ?? 0);
        if (bundleId !== undefined) {
          offsets.set(bundleId, (offsets.get(bundleId) ?? 0) + 1);
        }
        transaction.set(
          collections.reportRows.doc(
            workId(jobId, ["row", value.aggregateKey]),
          ),
          {
            publicationId: jobId,
            sectionKey,
            ordinal,
            ...(bundleKey === undefined ? {} : { bundleKey, bundleOrdinal }),
            row,
          },
        );
      }
      for (const [id, delta] of countScopes) {
        transaction.set(collections.reportCounts.doc(id), {
          publicationId: jobId,
          sectionKey: delta.sectionKey,
          ...(delta.bundleKey ? { bundleKey: delta.bundleKey } : {}),
          ...(delta.bundleId ? { bundleId: delta.bundleId } : {}),
          sequence: (priorCounts.get(id) ?? 0) + delta.value,
        });
      }
      const summaryEntries = [
        ...((Array.isArray(job.summaryEntries)
          ? job.summaryEntries
          : []) as DocumentData[]),
        ...outputs.filter((value) => value.sectionKey.startsWith("summary:")),
      ];
      if (complete) {
        const completedAtMs = Math.max(nowMs, job.asOfMs as number);
        const sectionManifest = sectionKeys.map((sectionKey) => {
          const id = reportCountId(jobId, sectionKey);
          return {
            sectionKey,
            total:
              (priorCounts.get(id) ?? 0) + (countScopes.get(id)?.value ?? 0),
          };
        });
        const publication = {
          version: JOB_VERSION,
          id: jobId,
          namespace: job.namespace,
          kind: "report",
          semanticKey: job.semanticKey,
          query: job.query,
          asOfMs: job.asOfMs,
          completedAtMs,
          sourceGeneration: job.sourceGeneration,
          projectionGeneration: job.projectionGeneration,
          schemaVersion: job.schemaVersion,
          storageVersion: job.storageVersion,
          accuracy: "exact",
          summary: summaryFromEntries(job, summaryEntries),
          sectionManifest,
        };
        transaction.create(collections.publications.doc(jobId), publication);
        transaction.update(collections.heads.doc(job.headId), {
          publicationId: jobId,
        });
        transaction.update(jobRef, {
          state: "ready",
          phase: "ready",
          completedAtMs,
          summaryEntries,
          revision: job.revision + 1,
        });
        return { state: "ready", phase: "ready", processed: documents.length };
      }
      const last = documents.at(-1)!;
      transaction.update(jobRef, {
        reduceAfterSection: last.data().sortSection,
        reduceAfterSort0: last.data().sort0,
        reduceAfterSort1: last.data().sort1,
        reduceAfterSort2: last.data().sort2,
        reduceAfterSort3: last.data().sort3,
        reduceAfterSort4: last.data().sort4,
        afterKey: last.data().aggregateKey,
        afterDocumentId: last.id,
        reduceCurrent: current,
        summaryEntries,
        revision: job.revision + 1,
      });
      return {
        state: "building",
        phase: "reduce",
        processed: documents.length,
      };
    },
    { maxAttempts: 1 },
  );

const matchesSearch = (job: DocumentData, event: BundleEventRow): boolean => {
  if (job.query.kind === "userId") {
    return event.user_id === job.query.value;
  }
  if (job.query.kind !== "contains") return invalidResult();
  const query = job.query.value;
  return [event.install_id, event.user_id, event.username].some(
    (value) => value !== null && value.toLowerCase().includes(query),
  );
};

const searchScanStep = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  jobId: string,
  maxItems: number,
  meter: FirebaseInsightsJobUsageMeter,
): Promise<FirebaseInsightsJobStepResult> =>
  runMeasuredTransaction(
    db,
    meter,
    async (transaction): Promise<FirebaseInsightsJobStepResult> => {
      const jobRef = collections.jobs.doc(jobId);
      const jobDocument = await transaction.get(jobRef);
      const job = assertJobDocument(jobDocument.data(), jobId);
      if (
        job.state !== "building" ||
        job.phase !== "searchScan" ||
        !isRecord(job.query) ||
        !Array.isArray(job.upperSequences) ||
        job.upperSequences.length !== SOURCE_IDS.length ||
        !Number.isSafeInteger(job.sourceIndex) ||
        !isTimestamp(job.afterSequence)
      )
        return invalidResult();
      let sourceIndex = job.sourceIndex as number;
      while (
        sourceIndex < SOURCE_IDS.length &&
        job.upperSequences[sourceIndex] === 0
      ) {
        sourceIndex += 1;
      }
      if (sourceIndex >= SOURCE_IDS.length) {
        transaction.update(jobRef, {
          phase: "searchReduce",
          sourceIndex,
          afterSequence: 0,
          afterKey: null,
          revision: job.revision + 1,
        });
        return { state: "building", phase: "searchReduce", processed: 0 };
      }
      const upper = job.upperSequences[sourceIndex];
      if (!isTimestamp(upper)) return invalidResult();
      const sourceShard = sourceShardValue(sourceIndex);
      const candidates = await transaction.get(
        collections.events
          .where("_insights_source_shard", "==", sourceShard)
          .where("_insights_source_seq", ">", job.afterSequence)
          .where("_insights_source_seq", "<=", upper)
          .orderBy("_insights_source_seq", "asc")
          .limit(maxItems + 1),
      );
      const documents = candidates.docs.slice(0, maxItems);
      const events = documents.map((document) => {
        const event = readStoredEvent(document.data(), document.ref.path);
        if (
          document.id !== firebaseEventDocumentId(event.id) ||
          document.data()._insights_source_shard !== sourceShard
        ) {
          return invalidResult();
        }
        return {
          event,
          sequence: readSequence({
            sequence: document.data()._insights_source_seq,
          }),
        };
      });
      const sourceComplete = candidates.size <= maxItems;
      assertContiguousSourceBatch(
        events.map(({ sequence }) => sequence),
        job.afterSequence,
        upper,
        sourceComplete,
      );
      const batch = new Map<
        string,
        { row: BundleEventRow; matched: boolean }
      >();
      for (const { event } of events) {
        const installKey = firebaseInstallationKey(event.install_id);
        const saved = batch.get(installKey);
        batch.set(installKey, {
          row:
            saved === undefined || isLater(event, saved.row)
              ? event
              : saved.row,
          matched: (saved?.matched ?? false) || matchesSearch(job, event),
        });
      }
      const work = [...batch.entries()].map(([installKey, value]) => ({
        installKey,
        value,
        ref: collections.work.doc(
          workId(jobId, ["searchCandidate", installKey]),
        ),
      }));
      const existing = work.length
        ? await transaction.getAll(...work.map(({ ref }) => ref))
        : [];
      existing.forEach((document, index) => {
        if (!document.exists) return;
        const item = work[index]!;
        const saved = document.data()!;
        const row = readStoredEvent(saved.row, document.ref.path);
        assertFirebaseInstallationIdentity(
          row.install_id,
          item.installKey,
          item.value.row.install_id,
        );
        item.value = {
          row: isLater(row, item.value.row) ? row : item.value.row,
          matched: saved.matched === true || item.value.matched,
        };
      });
      if (
        getCanonicalInsightsJsonByteLength([
          ...events.map(({ event }) => event),
          ...existing
            .filter((document) => document.exists)
            .map((document) => document.data()),
        ]) > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
      ) {
        return invalidResult();
      }
      for (const item of work) {
        transaction.set(item.ref, {
          jobId,
          recordKind: "searchCandidate",
          orderKey: item.installKey,
          installKey: item.installKey,
          matched: item.value.matched,
          row: item.value.row,
        });
      }
      const afterSequence = events.at(-1)?.sequence ?? job.afterSequence;
      let nextSourceIndex = sourceComplete ? sourceIndex + 1 : sourceIndex;
      while (
        nextSourceIndex < SOURCE_IDS.length &&
        job.upperSequences[nextSourceIndex] === 0
      ) {
        nextSourceIndex += 1;
      }
      const scanComplete = nextSourceIndex >= SOURCE_IDS.length;
      transaction.update(jobRef, {
        phase: scanComplete ? "searchReduce" : "searchScan",
        sourceIndex: nextSourceIndex,
        afterSequence: sourceComplete ? 0 : afterSequence,
        afterKey: null,
        revision: job.revision + 1,
      });
      return {
        state: "building",
        phase: scanComplete ? "searchReduce" : "searchScan",
        processed: documents.length,
      };
    },
    { maxAttempts: 1 },
  );

const searchReduceStep = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  jobId: string,
  maxItems: number,
  nowMs: number,
  meter: FirebaseInsightsJobUsageMeter,
): Promise<FirebaseInsightsJobStepResult> =>
  runMeasuredTransaction(
    db,
    meter,
    async (transaction): Promise<FirebaseInsightsJobStepResult> => {
      const jobRef = collections.jobs.doc(jobId);
      const jobDocument = await transaction.get(jobRef);
      const job = assertJobDocument(jobDocument.data(), jobId);
      if (
        job.state !== "building" ||
        job.phase !== "searchReduce" ||
        !isTimestamp(job.total)
      ) {
        return invalidResult();
      }
      let query = collections.work
        .where("jobId", "==", jobId)
        .where("recordKind", "==", "searchCandidate")
        .orderBy("orderKey", "asc");
      if (typeof job.afterKey === "string") {
        query = query.startAfter(job.afterKey);
      }
      const candidates = await transaction.get(query.limit(maxItems + 1));
      const documents = candidates.docs.slice(0, maxItems);
      const matched = documents.filter(
        (document) => document.data().matched === true,
      );
      const resultRefs = matched.map((document) =>
        collections.work.doc(workId(jobId, ["searchRow", document.id])),
      );
      const existing = resultRefs.length
        ? await transaction.getAll(...resultRefs)
        : [];
      const complete = candidates.size <= maxItems;
      const headDocument = complete
        ? await transaction.get(collections.heads.doc(job.headId))
        : null;
      if (
        headDocument !== null &&
        headDocument.data()?.currentJobId !== jobId
      ) {
        return invalidResult();
      }
      let added = 0;
      matched.forEach((document, index) => {
        const value = document.data();
        const row = readStoredEvent(value.row, document.ref.path);
        assertFirebaseInstallationIdentity(
          row.install_id,
          value.installKey,
          row.install_id,
        );
        if (existing[index]!.exists) return;
        transaction.create(resultRefs[index]!, {
          jobId,
          recordKind: "searchRow",
          orderKey: value.installKey,
          row: toInstallationRow(row),
        });
        added += 1;
      });
      const total = job.total + added;
      if (complete) {
        const completedAtMs = Math.max(nowMs, job.asOfMs as number);
        transaction.create(collections.publications.doc(jobId), {
          version: JOB_VERSION,
          id: jobId,
          namespace: job.namespace,
          kind: "search",
          semanticKey: job.semanticKey,
          query: job.query,
          asOfMs: job.asOfMs,
          completedAtMs,
          sourceGeneration: job.sourceGeneration,
          projectionGeneration: job.projectionGeneration,
          schemaVersion: job.schemaVersion,
          storageVersion: job.storageVersion,
          accuracy: "exact",
          total,
        });
        transaction.update(collections.heads.doc(job.headId), {
          publicationId: jobId,
        });
        transaction.update(jobRef, {
          state: "ready",
          phase: "ready",
          completedAtMs,
          total,
          revision: job.revision + 1,
        });
        return { state: "ready", phase: "ready", processed: documents.length };
      }
      transaction.update(jobRef, {
        afterKey: documents.at(-1)!.data().orderKey,
        total,
        revision: job.revision + 1,
      });
      return {
        state: "building",
        phase: "searchReduce",
        processed: documents.length,
      };
    },
    { maxAttempts: 1 },
  );

export const runFirebaseInsightsJobStep = async (
  db: Firestore,
  collections: FirebaseInsightsCollections,
  input: RunFirebaseInsightsJobInput,
): Promise<RunFirebaseInsightsJobResult> => {
  const maxItems = validateRunnerInput(input);
  if (input.maxRequests < 7) {
    return {
      state: "building",
      phase: "idle",
      processed: 0,
      usage: { items: 0, requests: 0, bytes: 0 },
    };
  }
  const meter: FirebaseInsightsJobUsageMeter = {
    items: 0,
    requests: 0,
    bytes: 0,
  };
  try {
    const document = await collections.jobs.doc(input.jobId).get();
    recordNativeRead(meter, document);
    const job = assertJobDocument(document.data(), input.jobId);
    if (job.state === "ready" || job.state === "failed") {
      return {
        state: job.state,
        phase: job.phase,
        processed: 0,
        usage: meter,
      };
    }
    let result: FirebaseInsightsJobStepResult;
    switch (job.phase) {
      case "searchScan":
        result = await searchScanStep(
          db,
          collections,
          input.jobId,
          Math.min(maxItems, MAX_SEARCH_JOB_ITEMS),
          meter,
        );
        break;
      case "searchReduce":
        result = await searchReduceStep(
          db,
          collections,
          input.jobId,
          Math.min(maxItems, MAX_SEARCH_JOB_ITEMS),
          input.nowMs,
          meter,
        );
        break;
      case "scan":
        result = await reportScanStep(
          db,
          collections,
          input.jobId,
          Math.min(maxItems, MAX_REPORT_JOB_ITEMS),
          meter,
        );
        break;
      case "transformLatest":
        result = await transformLatestStep(
          db,
          collections,
          input.jobId,
          Math.min(maxItems, MAX_REPORT_JOB_ITEMS),
          meter,
        );
        break;
      case "transformBuckets":
        result = await transformBucketsStep(
          db,
          collections,
          input.jobId,
          Math.min(maxItems, MAX_REPORT_JOB_ITEMS),
          meter,
        );
        break;
      case "seedDistribution":
        result = await seedDistributionStep(
          db,
          collections,
          input.jobId,
          Math.min(maxItems, MAX_REPORT_JOB_ITEMS),
          meter,
        );
        break;
      case "seedSeries":
        result = await seedSeriesStep(
          db,
          collections,
          input.jobId,
          Math.min(maxItems, MAX_REPORT_JOB_ITEMS),
          meter,
        );
        break;
      case "seedActiveBundles":
        result = await seedActiveBundlesStep(
          db,
          collections,
          input.jobId,
          Math.min(maxItems, MAX_REPORT_JOB_ITEMS),
          meter,
        );
        break;
      case "reduce":
        result = await reduceStep(
          db,
          collections,
          input.jobId,
          Math.min(maxItems, MAX_REPORT_JOB_ITEMS),
          input.nowMs,
          meter,
        );
        break;
      default:
        return invalidResult();
    }
    return {
      ...result,
      usage: { ...meter, items: result.processed },
    };
  } catch (error) {
    if (
      !(error instanceof DatabasePluginInputError) ||
      error.code !== "invalid-result"
    ) {
      throw error;
    }
    const failureCode =
      error instanceof FirebaseInsightsStorageCorruptionError
        ? "storage-corruption"
        : "migration-poison";
    const failed = await runMeasuredTransaction(
      db,
      meter,
      async (transaction): Promise<FirebaseInsightsJobStepResult> => {
        const reference = collections.jobs.doc(input.jobId);
        const document = await transaction.get(reference);
        const job = assertJobDocument(document.data(), input.jobId);
        if (job.state === "building") {
          transaction.update(reference, {
            state: "failed",
            phase: "failed",
            failureCode,
            revision: job.revision + 1,
          });
        }
        return { state: "failed", phase: "failed", processed: 0 };
      },
      { maxAttempts: 1 },
    );
    return {
      ...failed,
      usage: { ...meter, items: 0 },
    };
  }
};
