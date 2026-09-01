import {
  DatabasePluginInputError,
  type BundleEventRow,
  type InsightsInstallationPage,
  type InsightsInstallationPageInput,
  type InsightsInstallationRow,
  type InsightsLiveInstallationPage,
  type InsightsPageEventsInput,
  type InsightsPageEventsResult,
  type InsightsReadFailure,
  type InsightsReadVersions,
  type InsightsReportInput,
  type InsightsReportPage,
  type InsightsReportPageInput,
  type InsightsReportResult,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsPageContract,
  assertInsightsQueryContract,
  assertInsightsEventRow,
  getCanonicalInsightsJsonByteLength,
  compareInsightsEventRows,
  INSIGHTS_CURSOR_MAX_BYTES,
  INSIGHTS_PAGE_MAX_ROWS,
  type RequiredInsightsModel,
} from "@hot-updater/plugin-core/internal";
import {
  FieldPath,
  type CollectionReference,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  type Query,
} from "firebase-admin/firestore";

import { parseFirebaseBundleEventRow } from "./firebaseDatabaseParser";
import {
  FIREBASE_INSIGHTS_CANDIDATE_BYTES,
  FIREBASE_INSIGHTS_EVENT_BYTES,
  FIREBASE_INSIGHTS_INDEX_REVISION,
  FIREBASE_INSIGHTS_LAYOUT_VERSION,
  FIREBASE_INSIGHTS_PAGE_SHARDS,
  FIREBASE_INSIGHTS_SOURCE_IDS,
  assertFirebaseInstallationIdentity,
  firebaseEventDocumentId,
  firebaseEventJsonBytes,
  firebaseEventPageShard,
  firebaseEventScopeKey,
  firebaseInstallationKey,
  firebaseInstallationSourceVersionId,
  isFirebaseEventId,
  isFirebaseScopeText,
} from "./firebaseEventIndex";
import { FIREBASE_V2_INSIGHTS_COLLECTION_NAMES } from "./firebaseInfrastructureNames";
import {
  getFirebaseInsightsReport,
  pageFirebaseInsightsPublishedInstallations,
  pageFirebaseInsightsReport,
} from "./firebaseInsightsJobs";

const MAX_PAGE_SIZE = INSIGHTS_PAGE_MAX_ROWS;
const MAX_INSTALLATION_ROWS = 45;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CURSOR_RESERVE_BYTES = 64 * 1024;
const MAX_CURSOR_BYTES = INSIGHTS_CURSOR_MAX_BYTES;
const SCHEMA_VERSION = FIREBASE_INSIGHTS_INDEX_REVISION;
const STORAGE_VERSION = "firebase-insights-v2";

class FirebaseInsightsIndexNotReadyError extends Error {}

class FirebaseInsightsStorageCorruptionError extends Error {}

export interface FirebaseInsightsCollections {
  readonly control: CollectionReference<DocumentData>;
  readonly events: CollectionReference<DocumentData>;
  readonly heads: CollectionReference<DocumentData>;
  readonly installations: CollectionReference<DocumentData>;
  readonly installationVersions: CollectionReference<DocumentData>;
  readonly jobs: CollectionReference<DocumentData>;
  readonly poison: CollectionReference<DocumentData>;
  readonly publications: CollectionReference<DocumentData>;
  readonly reportCounts: CollectionReference<DocumentData>;
  readonly reportRows: CollectionReference<DocumentData>;
  readonly sourceClocks: CollectionReference<DocumentData>;
  readonly work: CollectionReference<DocumentData>;
}

export const createFirebaseInsightsCollections = (
  db: Firestore,
): FirebaseInsightsCollections => ({
  control: db.collection(FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.control),
  events: db.collection(FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.events),
  heads: db.collection(FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.heads),
  installations: db.collection(
    FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.installations,
  ),
  installationVersions: db.collection(
    FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.installationVersions,
  ),
  jobs: db.collection(FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.jobs),
  poison: db.collection(FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.poison),
  publications: db.collection(
    FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.publications,
  ),
  reportCounts: db.collection(
    FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.reportCounts,
  ),
  reportRows: db.collection(FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.reportRows),
  sourceClocks: db.collection(
    FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.sourceClocks,
  ),
  work: db.collection(FIREBASE_V2_INSIGHTS_COLLECTION_NAMES.work),
});

type Position = {
  readonly receivedAtMs: number;
  readonly id: string;
};

type Stream = {
  readonly key: string;
  readonly pageShard: number;
  readonly filters: readonly [string, string | number][];
  buffer: BundleEventRow[];
  exhausted: boolean;
  emitted?: Position;
};

const invalidQuery = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const isTimestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isRecord = (value: unknown): value is DocumentData =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pageScopeKey = (input: InsightsPageEventsInput): string => {
  const { selector } = input;
  if (typeof selector !== "object" || selector === null) return invalidQuery();
  if (selector.kind === "all") {
    if (!Object.keys(selector).every((field) => field === "kind")) {
      return invalidQuery();
    }
    return firebaseEventScopeKey(JSON.stringify(["all"]));
  }
  if (
    selector.kind === "installationId" &&
    Object.keys(selector).every((field) =>
      ["kind", "installId"].includes(field),
    ) &&
    typeof selector.installId === "string" &&
    isFirebaseScopeText(selector.installId)
  ) {
    return firebaseEventScopeKey(
      JSON.stringify(["installationId", selector.installId]),
    );
  }
  if (
    selector.kind === "bundleId" &&
    Object.keys(selector).every((field) =>
      ["kind", "bundleId"].includes(field),
    ) &&
    typeof selector.bundleId === "string" &&
    selector.bundleId.length > 0 &&
    isFirebaseScopeText(selector.bundleId)
  ) {
    return firebaseEventScopeKey(
      JSON.stringify(["bundleId", selector.bundleId]),
    );
  }
  return invalidQuery();
};

const validatePageInput = (input: InsightsPageEventsInput): string => {
  try {
    assertInsightsQueryContract(input);
    if (input.cursor !== undefined) assertInsightsCursorContract(input.cursor);
  } catch {
    return invalidQuery();
  }
  if (
    typeof input !== "object" ||
    input === null ||
    !Object.keys(input).every((field) =>
      [
        "selector",
        "sinceReceivedAtMs",
        "beforeReceivedAtMs",
        "limit",
        "cursor",
      ].includes(field),
    ) ||
    !isTimestamp(input.beforeReceivedAtMs) ||
    (input.sinceReceivedAtMs !== undefined &&
      !isTimestamp(input.sinceReceivedAtMs)) ||
    (input.sinceReceivedAtMs ?? 0) > input.beforeReceivedAtMs ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_PAGE_SIZE
  ) {
    return invalidQuery();
  }
  return pageScopeKey(input);
};

const streamsFor = (input: InsightsPageEventsInput): Stream[] => {
  const streams: Stream[] = [];
  const add = (
    prefix: string,
    filters: readonly [string, string | number][],
  ) => {
    for (
      let pageShard = 0;
      pageShard < FIREBASE_INSIGHTS_PAGE_SHARDS;
      pageShard += 1
    ) {
      streams.push({
        key: `${prefix}:${pageShard}`,
        pageShard,
        filters,
        buffer: [],
        exhausted: false,
      });
    }
  };
  switch (input.selector.kind) {
    case "all":
      add("all", []);
      break;
    case "installationId": {
      const installKey = firebaseEventScopeKey(input.selector.installId);
      add("installation:applied", [
        ["_insights_install_key", installKey],
        ["type", "UPDATE_APPLIED"],
      ]);
      add("installation:recovered", [
        ["_insights_install_key", installKey],
        ["type", "RECOVERED"],
      ]);
      break;
    }
    case "bundleId": {
      const bundleKey = firebaseEventScopeKey(input.selector.bundleId);
      add("bundle:applied", [
        ["type", "UPDATE_APPLIED"],
        ["_insights_to_bundle_key", bundleKey],
      ]);
      add("bundle:recovered", [
        ["type", "RECOVERED"],
        ["_insights_from_bundle_key", bundleKey],
      ]);
      break;
    }
  }
  return streams;
};

const readCursor = (
  input: InsightsPageEventsInput,
  namespace: string,
  scopeKey: string,
  streams: Stream[],
): void => {
  if (input.cursor === undefined) return;
  if (
    typeof input.cursor !== "string" ||
    Buffer.byteLength(input.cursor, "utf8") > MAX_CURSOR_BYTES
  ) {
    invalidQuery();
  }
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    return invalidQuery();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 7 ||
    value[0] !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
    value[1] !== namespace ||
    value[2] !== scopeKey ||
    value[3] !== (input.sinceReceivedAtMs ?? 0) ||
    value[4] !== input.beforeReceivedAtMs ||
    value[5] !== FIREBASE_INSIGHTS_PAGE_SHARDS ||
    !Array.isArray(value[6]) ||
    value[6].length !== streams.length
  ) {
    return invalidQuery();
  }
  for (let index = 0; index < streams.length; index += 1) {
    const saved = value[6][index];
    const stream = streams[index]!;
    if (
      !Array.isArray(saved) ||
      saved.length !== 3 ||
      saved[0] !== stream.key ||
      (saved[1] !== null && !isTimestamp(saved[1])) ||
      (saved[2] !== null &&
        (typeof saved[2] !== "string" || !isFirebaseEventId(saved[2]))) ||
      (saved[1] === null) !== (saved[2] === null)
    ) {
      return invalidQuery();
    }
    if (saved[1] !== null) {
      if (
        saved[1] < (input.sinceReceivedAtMs ?? 0) ||
        saved[1] >= input.beforeReceivedAtMs
      ) {
        return invalidQuery();
      }
      stream.emitted = { receivedAtMs: saved[1], id: saved[2] };
    }
  }
};

const createCursor = (
  input: InsightsPageEventsInput,
  namespace: string,
  scopeKey: string,
  streams: readonly Stream[],
): string => {
  const cursor = JSON.stringify([
    FIREBASE_INSIGHTS_LAYOUT_VERSION,
    namespace,
    scopeKey,
    input.sinceReceivedAtMs ?? 0,
    input.beforeReceivedAtMs,
    FIREBASE_INSIGHTS_PAGE_SHARDS,
    streams.map(({ key, emitted }) => [
      key,
      emitted?.receivedAtMs ?? null,
      emitted?.id ?? null,
    ]),
  ]);
  if (Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return cursor;
};

const matchesStream = (
  data: DocumentData,
  stream: Stream,
  row: BundleEventRow,
  input: InsightsPageEventsInput,
): boolean => {
  if (
    data._insights_layout_version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
    data._insights_page_shard !== stream.pageShard ||
    firebaseEventPageShard(row.id) !== stream.pageShard ||
    data._insights_install_key !== firebaseEventScopeKey(row.install_id) ||
    data._insights_to_bundle_key !== firebaseEventScopeKey(row.to_bundle_id) ||
    data._insights_from_bundle_key !==
      (row.from_bundle_id === null
        ? null
        : firebaseEventScopeKey(row.from_bundle_id)) ||
    !stream.filters.every(([field, expected]) => data[field] === expected)
  ) {
    return false;
  }
  if (input.selector.kind === "installationId") {
    return row.install_id === input.selector.installId;
  }
  if (input.selector.kind === "bundleId") {
    return stream.key.startsWith("bundle:applied")
      ? row.to_bundle_id === input.selector.bundleId
      : row.from_bundle_id === input.selector.bundleId;
  }
  return true;
};

const mapFirestoreIndexError = (error: unknown): never => {
  if (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === 9
  ) {
    throw new FirebaseInsightsIndexNotReadyError();
  }
  throw error;
};

const publicEvent = (data: DocumentData, path: string): BundleEventRow => {
  const parsed = parseFirebaseBundleEventRow(data, path);
  const row = Object.assign(
    Object.fromEntries(
      Object.entries(data).filter(([field]) => !field.startsWith("_insights_")),
    ),
    parsed,
  ) as BundleEventRow;
  assertInsightsEventRow(row);
  if (
    !isFirebaseEventId(row.id) ||
    firebaseEventJsonBytes(row) > FIREBASE_INSIGHTS_EVENT_BYTES
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return row;
};

const readStream = async (
  events: CollectionReference<DocumentData>,
  input: InsightsPageEventsInput,
  stream: Stream,
  chunkSize: number,
): Promise<BundleEventRow[]> => {
  let query: Query<DocumentData> = events.where(
    "_insights_page_shard",
    "==",
    stream.pageShard,
  );
  for (const [field, value] of stream.filters) {
    query = query.where(field, "==", value);
  }
  query = query
    .where("received_at_ms", ">=", input.sinceReceivedAtMs ?? 0)
    .where("received_at_ms", "<", input.beforeReceivedAtMs)
    .orderBy("received_at_ms", "desc")
    .orderBy("id", "desc");
  if (stream.emitted) {
    query = query.startAfter(stream.emitted.receivedAtMs, stream.emitted.id);
  }
  try {
    const snapshot = await query.limit(chunkSize).get();
    stream.exhausted = snapshot.size < chunkSize;
    const rows = snapshot.docs.map((document) => {
      const data = document.data();
      const row = publicEvent(data, document.ref.path);
      if (
        document.id !== firebaseEventDocumentId(row.id) ||
        !matchesStream(data, stream, row, input) ||
        row.received_at_ms < (input.sinceReceivedAtMs ?? 0) ||
        row.received_at_ms >= input.beforeReceivedAtMs
      ) {
        throw new FirebaseInsightsStorageCorruptionError();
      }
      return row;
    });
    if (
      rows.some(
        (row, index) =>
          index > 0 && compareInsightsEventRows(rows[index - 1]!, row) >= 0,
      )
    ) {
      throw new DatabasePluginInputError("invalid-result");
    }
    return rows;
  } catch (error) {
    return mapFirestoreIndexError(error);
  }
};

const bufferedBytes = (streams: readonly Stream[]): number =>
  streams.reduce(
    (total, stream) =>
      total +
      stream.buffer.reduce(
        (streamTotal, row) => streamTotal + firebaseEventJsonBytes(row),
        0,
      ),
    0,
  );

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

const installationCursorKey = (
  input: InsightsInstallationPageInput,
): string => {
  if (input.kind === "all") {
    return firebaseEventScopeKey(JSON.stringify(["all"]));
  }
  if (
    input.kind === "installationId" &&
    typeof input.installId === "string" &&
    isFirebaseScopeText(input.installId)
  ) {
    return firebaseEventScopeKey(
      JSON.stringify(["installationId", input.installId]),
    );
  }
  return invalidQuery();
};

const readSourceState = async (
  collections: FirebaseInsightsCollections,
): Promise<{
  readonly generation: string;
  readonly observedAtMs: number;
  readonly upperSequences: readonly number[];
}> => {
  const documents = await collections.sourceClocks.firestore.getAll(
    ...FIREBASE_INSIGHTS_SOURCE_IDS.map((id) =>
      collections.sourceClocks.doc(id),
    ),
  );
  return readSourceDocuments(documents);
};

const readSourceDocuments = (
  documents: readonly DocumentSnapshot<DocumentData>[],
): {
  readonly generation: string;
  readonly observedAtMs: number;
  readonly upperSequences: readonly number[];
} => {
  if (documents.length !== FIREBASE_INSIGHTS_SOURCE_IDS.length) {
    throw new DatabasePluginInputError("invalid-result");
  }
  let observedAtMs = 0;
  const vector = documents.map((document, index) => {
    const sourceId = FIREBASE_INSIGHTS_SOURCE_IDS[index]!;
    const expectedShard =
      sourceId === "legacy"
        ? "legacy"
        : Number.parseInt(sourceId.slice("live_".length), 16);
    const data = document.data();
    const sequence = data?.sequence;
    if (
      !document.exists ||
      data?.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
      data?.shard !== expectedShard ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    ) {
      throw new DatabasePluginInputError("invalid-result");
    }
    const observed = data.observedAtMs;
    if (!isTimestamp(observed)) {
      throw new DatabasePluginInputError("invalid-result");
    }
    observedAtMs = Math.max(observedAtMs, observed);
    return [sourceId, sequence] as const;
  });
  return {
    generation: firebaseEventScopeKey(JSON.stringify(vector)),
    observedAtMs,
    upperSequences: vector.map(([, sequence]) => sequence),
  };
};

const corruptionSourceGeneration = (
  documents: readonly DocumentSnapshot<DocumentData>[],
): string =>
  firebaseEventScopeKey(
    JSON.stringify(
      FIREBASE_INSIGHTS_SOURCE_IDS.map((sourceId, index) => {
        const document = documents[index];
        const data = document?.data();
        const field = (value: unknown) =>
          value === null ||
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
            ? value
            : typeof value;
        return [
          sourceId,
          document?.exists ?? false,
          field(data?.version),
          field(data?.shard),
          field(data?.sequence),
          field(data?.observedAtMs),
        ];
      }),
    ),
  );

type LiveReadiness =
  | {
      readonly ready: true;
      readonly source: ReturnType<typeof readSourceDocuments>;
      readonly projectionObservedAtMs: number | null;
    }
  | {
      readonly ready: false;
      readonly versions: InsightsReadVersions;
      readonly error: InsightsReadFailure;
    };

const failedReadiness = (
  sourceGeneration: string | null,
  projectionGeneration: string | null,
  error: InsightsReadFailure,
): LiveReadiness => ({
  ready: false,
  versions: {
    schemaVersion:
      sourceGeneration === null ? null : FIREBASE_INSIGHTS_INDEX_REVISION,
    storageVersion: sourceGeneration === null ? null : STORAGE_VERSION,
    projectionGeneration,
    sourceGeneration,
  },
  error,
});

const readLiveReadiness = async (
  collections: FirebaseInsightsCollections,
  requireProjection: boolean,
): Promise<LiveReadiness> => {
  const references = [
    collections.control.doc("layout"),
    ...(requireProjection ? [collections.control.doc("projection")] : []),
    ...FIREBASE_INSIGHTS_SOURCE_IDS.map((id) =>
      collections.sourceClocks.doc(id),
    ),
  ];
  const documents = await collections.control.firestore.getAll(...references);
  const layout = documents[0]!;
  const projection = requireProjection ? documents[1]! : null;
  const clocks = documents.slice(requireProjection ? 2 : 1);
  if (!layout.exists) {
    return failedReadiness(null, null, { code: "storage-not-ready" });
  }
  const state = layout.data();
  if (
    state?.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
    !["building", "failed", "ready"].includes(state.state) ||
    state.indexRevision !== FIREBASE_INSIGHTS_INDEX_REVISION
  ) {
    return failedReadiness(corruptionSourceGeneration(clocks), null, {
      code: "storage-corruption",
    });
  }
  let source: ReturnType<typeof readSourceDocuments>;
  try {
    source = readSourceDocuments(clocks);
  } catch {
    return failedReadiness(corruptionSourceGeneration(clocks), null, {
      code: "storage-corruption",
    });
  }
  if (state.state === "failed") {
    if (typeof state.poisonId !== "string") {
      return failedReadiness(source.generation, null, {
        code: "storage-corruption",
      });
    }
    return failedReadiness(source.generation, null, {
      code: "migration-poison",
      jobId: "firebase-v2-backfill",
    });
  }
  if (state.state !== "ready") {
    return failedReadiness(source.generation, null, {
      code: "storage-not-ready",
    });
  }
  if (!requireProjection) {
    return { ready: true, source, projectionObservedAtMs: null };
  }
  if (!projection!.exists) {
    return failedReadiness(source.generation, null, {
      code: "source-not-ready",
    });
  }
  const projectionData = projection!.data();
  if (
    projectionData?.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
    projectionData.state !== "ready" ||
    typeof projectionData.generation !== "string" ||
    !/^[0-9a-f]{64}$/.test(projectionData.generation) ||
    !isTimestamp(projectionData.observedAtMs)
  ) {
    return failedReadiness(source.generation, null, {
      code: "storage-corruption",
    });
  }
  return {
    ready: true,
    source,
    projectionObservedAtMs: projectionData.observedAtMs,
  };
};

type InstallationSnapshot = {
  readonly generation: string;
  readonly observedAtMs: number;
  readonly upperSequences: readonly number[];
  readonly after: string | null;
};

const readInstallationSnapshotCursor = (
  input: InsightsInstallationPageInput,
  namespace: string,
  scopeKey: string,
): InstallationSnapshot | null => {
  if (input.cursor === undefined) return null;
  if (
    Object.getOwnPropertyDescriptor(input, "kind")?.value === "installationId"
  )
    return invalidQuery();
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    return invalidQuery();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 8 ||
    value[0] !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
    value[1] !== namespace ||
    value[2] !== "installations-live" ||
    value[3] !== scopeKey ||
    typeof value[4] !== "string" ||
    !isTimestamp(value[5]) ||
    !Array.isArray(value[6]) ||
    value[6].length !== FIREBASE_INSIGHTS_SOURCE_IDS.length ||
    value[6].some((sequence) => !isTimestamp(sequence)) ||
    typeof value[7] !== "string" ||
    !/^[0-9a-f]{64}$/.test(value[7])
  ) {
    return invalidQuery();
  }
  const upperSequences = value[6] as number[];
  const vector = FIREBASE_INSIGHTS_SOURCE_IDS.map(
    (sourceId, index) => [sourceId, upperSequences[index]!] as const,
  );
  if (value[4] !== firebaseEventScopeKey(JSON.stringify(vector))) {
    return invalidQuery();
  }
  return {
    generation: value[4],
    observedAtMs: value[5],
    upperSequences,
    after: value[7],
  };
};

const createInstallationSnapshotCursor = (
  namespace: string,
  scopeKey: string,
  snapshot: Omit<InstallationSnapshot, "after">,
  after: string,
): string => {
  const cursor = JSON.stringify([
    FIREBASE_INSIGHTS_LAYOUT_VERSION,
    namespace,
    "installations-live",
    scopeKey,
    snapshot.generation,
    snapshot.observedAtMs,
    snapshot.upperSequences,
    after,
  ]);
  if (Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return cursor;
};

const readInstallationProjection = (
  value: unknown,
  installKey: string,
): InsightsInstallationRow => {
  if (!isRecord(value)) {
    throw new DatabasePluginInputError("invalid-result");
  }
  const row = value as InsightsInstallationRow;
  if (
    !isFirebaseEventId(row.id) ||
    typeof row.install_id !== "string" ||
    firebaseInstallationKey(row.install_id) !== installKey ||
    !isTimestamp(row.received_at_ms)
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return row;
};

const resolveInstallationSnapshot = async (
  collections: FirebaseInsightsCollections,
  installKey: string,
  sourceIds: readonly string[],
  upperSequences: readonly number[],
): Promise<InsightsInstallationRow> => {
  let latest: InsightsInstallationRow | null = null;
  for (const sourceId of sourceIds) {
    const sourceIndex = FIREBASE_INSIGHTS_SOURCE_IDS.findIndex(
      (candidate) => candidate === sourceId,
    );
    if (sourceIndex < 0) {
      throw new DatabasePluginInputError("invalid-result");
    }
    const upper = upperSequences[sourceIndex]!;
    if (upper === 0) continue;
    const prefix = await collections.installationVersions
      .where("recordKind", "==", "prefix")
      .where("installKey", "==", installKey)
      .where("sourceId", "==", sourceId)
      .where("sourceSequence", "<=", upper)
      .orderBy("sourceSequence", "desc")
      .limit(1)
      .get();
    if (prefix.empty) continue;
    const document = prefix.docs[0]!;
    const data = document.data();
    if (
      data.version !== FIREBASE_INSIGHTS_LAYOUT_VERSION ||
      data.recordKind !== "prefix" ||
      data.installKey !== installKey ||
      data.sourceId !== sourceId ||
      !isTimestamp(data.sourceSequence) ||
      data.sourceSequence > upper ||
      document.id !==
        firebaseInstallationSourceVersionId(
          installKey,
          sourceId,
          data.sourceSequence,
        )
    ) {
      throw new DatabasePluginInputError("invalid-result");
    }
    const row = readInstallationProjection(data.row, installKey);
    if (
      latest === null ||
      row.received_at_ms > latest.received_at_ms ||
      (row.received_at_ms === latest.received_at_ms && row.id > latest.id)
    ) {
      latest = row;
    }
  }
  if (latest === null) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return latest;
};

const sourceVersions = (source: ReturnType<typeof readSourceDocuments>) => ({
  schemaVersion: SCHEMA_VERSION,
  storageVersion: STORAGE_VERSION,
  projectionGeneration: null,
  sourceGeneration: source.generation,
});

export const createFirebaseInsightsQueries = (
  collections: FirebaseInsightsCollections,
  namespace: string,
  append: (row: BundleEventRow) => Promise<void>,
) =>
  ({
    append,

    async pageEvents(
      input: InsightsPageEventsInput,
    ): Promise<InsightsPageEventsResult> {
      const scopeKey = validatePageInput(input);
      const streams = streamsFor(input);
      readCursor(input, namespace, scopeKey, streams);
      const readiness = await readLiveReadiness(collections, false);
      if (!readiness.ready) {
        return {
          state: "failed",
          versions: readiness.versions,
          error: readiness.error,
        };
      }
      const chunkSize = input.selector.kind === "all" ? 8 : 4;
      try {
        await Promise.all(
          streams.map(async (stream) => {
            if (!stream.exhausted) {
              stream.buffer = await readStream(
                collections.events,
                input,
                stream,
                chunkSize,
              );
            }
          }),
        );
      } catch (error) {
        if (error instanceof FirebaseInsightsIndexNotReadyError) {
          return {
            state: "failed",
            versions: sourceVersions(readiness.source),
            error: { code: "index-not-ready" },
          };
        }
        if (error instanceof FirebaseInsightsStorageCorruptionError) {
          return {
            state: "failed",
            versions: sourceVersions(readiness.source),
            error: { code: "storage-corruption" },
          };
        }
        throw error;
      }
      if (bufferedBytes(streams) > FIREBASE_INSIGHTS_CANDIDATE_BYTES) {
        throw new DatabasePluginInputError("invalid-result");
      }

      const rows: BundleEventRow[] = [];
      const ids = new Set<string>();
      while (rows.length < input.limit) {
        let selected: Stream | undefined;
        for (const stream of streams) {
          const head = stream.buffer[0];
          const current = selected?.buffer[0];
          if (
            head &&
            (!current || compareInsightsEventRows(head, current) < 0)
          ) {
            selected = stream;
          }
        }
        if (!selected) break;
        const row = selected.buffer[0]!;
        const tentativeBytes = Buffer.byteLength(
          JSON.stringify([...rows, row]),
          "utf8",
        );
        if (
          rows.length > 0 &&
          tentativeBytes + CURSOR_RESERVE_BYTES > MAX_RESPONSE_BYTES
        ) {
          break;
        }
        selected.buffer.shift();
        selected.emitted = {
          receivedAtMs: row.received_at_ms,
          id: row.id,
        };
        if (ids.has(row.id)) {
          throw new DatabasePluginInputError("invalid-result");
        }
        ids.add(row.id);
        rows.push(row);
        if (
          rows.length < input.limit &&
          selected.buffer.length === 0 &&
          !selected.exhausted
        ) {
          try {
            selected.buffer = await readStream(
              collections.events,
              input,
              selected,
              chunkSize,
            );
          } catch (error) {
            if (error instanceof FirebaseInsightsIndexNotReadyError) {
              return {
                state: "failed",
                versions: sourceVersions(readiness.source),
                error: { code: "index-not-ready" },
              };
            }
            if (error instanceof FirebaseInsightsStorageCorruptionError) {
              return {
                state: "failed",
                versions: sourceVersions(readiness.source),
                error: { code: "storage-corruption" },
              };
            }
            throw error;
          }
          if (bufferedBytes(streams) > FIREBASE_INSIGHTS_CANDIDATE_BYTES) {
            throw new DatabasePluginInputError("invalid-result");
          }
        }
      }
      const hasMore = streams.some(
        (stream) => stream.buffer.length > 0 || !stream.exhausted,
      );
      const nextCursor = hasMore
        ? createCursor(input, namespace, scopeKey, streams)
        : null;
      const result: InsightsPageEventsResult = {
        state: "ready",
        versions: sourceVersions(readiness.source),
        data: {
          data: rows,
          nextCursor,
          hasNext: nextCursor !== null,
          consistency: {
            kind: "live",
            cutoff: {
              kind: "event-time",
              beforeReceivedAtMs: input.beforeReceivedAtMs,
            },
          },
          total: { state: "unavailable" },
        },
      };
      try {
        assertInsightsPageContract(result, input.limit);
      } catch {
        throw new DatabasePluginInputError("invalid-result");
      }
      return result;
    },

    async pageInstallations(
      input: InsightsInstallationPageInput,
    ): Promise<InsightsInstallationPage> {
      try {
        assertInsightsQueryContract(input);
        if (input.cursor !== undefined)
          assertInsightsCursorContract(input.cursor);
      } catch {
        return invalidQuery();
      }
      if (
        typeof input !== "object" ||
        input === null ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_PAGE_SIZE
      ) {
        return invalidQuery();
      }
      const allowedFields =
        input.kind === "all"
          ? ["kind", "limit", "cursor"]
          : input.kind === "installationId"
            ? ["kind", "installId", "limit", "cursor"]
            : input.kind === "userId"
              ? [
                  "kind",
                  "userId",
                  "publicationId",
                  "minAsOfMs",
                  "limit",
                  "cursor",
                ]
              : [
                  "kind",
                  "query",
                  "publicationId",
                  "minAsOfMs",
                  "limit",
                  "cursor",
                ];
      if (!Object.keys(input).every((field) => allowedFields.includes(field))) {
        return invalidQuery();
      }
      if (input.kind === "contains" || input.kind === "userId") {
        return pageFirebaseInsightsPublishedInstallations(
          collections,
          namespace,
          input,
        );
      }
      const scopeKey = installationCursorKey(input);
      const cursorSnapshot = readInstallationSnapshotCursor(
        input,
        namespace,
        scopeKey,
      );
      const readiness = await readLiveReadiness(collections, true);
      if (!readiness.ready) {
        return {
          state: "failed",
          versions: readiness.versions,
          error: readiness.error,
        };
      }
      const page = (
        snapshot: Omit<InstallationSnapshot, "after">,
        data: readonly InsightsInstallationRow[],
        nextCursor: string | null,
      ): InsightsLiveInstallationPage => {
        const versions = {
          schemaVersion: SCHEMA_VERSION,
          storageVersion: STORAGE_VERSION,
          projectionGeneration: snapshot.generation,
          sourceGeneration: snapshot.generation,
        };
        const result: InsightsLiveInstallationPage = {
          state: "ready",
          versions,
          data: {
            data,
            nextCursor,
            hasNext: nextCursor !== null,
            consistency: {
              kind: "live",
              cutoff: {
                kind: "projection",
                observedAtMs: snapshot.observedAtMs,
                projectionGeneration: snapshot.generation,
              },
            },
            total: { state: "unavailable" },
          },
        };
        try {
          assertInsightsPageContract(result, input.limit);
        } catch {
          throw new DatabasePluginInputError("invalid-result");
        }
        return result;
      };
      try {
        if (input.kind === "installationId") {
          const source = readiness.source;
          const snapshot = {
            generation: source.generation,
            observedAtMs: Math.max(
              readiness.projectionObservedAtMs!,
              source.observedAtMs,
            ),
            upperSequences: source.upperSequences,
          };
          const key = firebaseInstallationKey(input.installId);
          const document = await collections.installations.doc(key).get();
          const stable = await readSourceState(collections);
          if (
            stable.generation !== source.generation ||
            stable.observedAtMs !== source.observedAtMs
          ) {
            return {
              state: "failed",
              versions: {
                schemaVersion: SCHEMA_VERSION,
                storageVersion: STORAGE_VERSION,
                projectionGeneration: source.generation,
                sourceGeneration: source.generation,
              },
              error: { code: "source-not-ready" },
            };
          }
          if (!document.exists) {
            return page(snapshot, [], null);
          }
          const row = publicEvent(document.data()!, document.ref.path);
          assertFirebaseInstallationIdentity(
            input.installId,
            document.id,
            row.install_id,
          );
          return page(snapshot, [toInstallationRow(row)], null);
        }
        const source =
          cursorSnapshot === null ? readiness.source : cursorSnapshot;
        const snapshot = {
          generation: source.generation,
          observedAtMs:
            cursorSnapshot === null
              ? Math.max(readiness.projectionObservedAtMs!, source.observedAtMs)
              : source.observedAtMs,
          upperSequences: source.upperSequences,
        };
        let query: Query<DocumentData> = collections.installations.orderBy(
          FieldPath.documentId(),
          "asc",
        );
        if (cursorSnapshot?.after)
          query = query.startAfter(cursorSnapshot.after);
        const pageLimit = Math.min(input.limit, MAX_INSTALLATION_ROWS);
        const candidates = await query.limit(pageLimit + 1).get();
        const rows: InsightsInstallationRow[] = [];
        const scanned: typeof candidates.docs = [];
        for (const document of candidates.docs.slice(0, pageLimit)) {
          const data = document.data();
          const firstSourceId = data._insights_first_source_id;
          const firstSourceSequence = data._insights_first_source_seq;
          const sourceIds = data._insights_source_ids;
          const firstSourceIndex = FIREBASE_INSIGHTS_SOURCE_IDS.findIndex(
            (sourceId) => sourceId === firstSourceId,
          );
          if (
            firstSourceIndex < 0 ||
            !isTimestamp(firstSourceSequence) ||
            firstSourceSequence < 1 ||
            !Array.isArray(sourceIds) ||
            sourceIds.length < 1 ||
            sourceIds.length > FIREBASE_INSIGHTS_SOURCE_IDS.length ||
            sourceIds.some(
              (sourceId) =>
                typeof sourceId !== "string" ||
                !FIREBASE_INSIGHTS_SOURCE_IDS.some(
                  (candidate) => candidate === sourceId,
                ),
            ) ||
            new Set(sourceIds).size !== sourceIds.length ||
            !sourceIds.includes(firstSourceId)
          ) {
            throw new DatabasePluginInputError("invalid-result");
          }
          if (
            firstSourceSequence > snapshot.upperSequences[firstSourceIndex]!
          ) {
            scanned.push(document);
            continue;
          }
          const row = await resolveInstallationSnapshot(
            collections,
            document.id,
            sourceIds,
            snapshot.upperSequences,
          );
          if (
            rows.length > 0 &&
            getCanonicalInsightsJsonByteLength([...rows, row]) +
              CURSOR_RESERVE_BYTES >
              MAX_RESPONSE_BYTES
          ) {
            break;
          }
          scanned.push(document);
          rows.push(row);
        }
        const last = scanned.at(-1)?.id;
        const nextCursor =
          candidates.size > scanned.length && last
            ? createInstallationSnapshotCursor(
                namespace,
                scopeKey,
                snapshot,
                last,
              )
            : null;
        return page(snapshot, rows, nextCursor);
      } catch (error) {
        if (
          error instanceof DatabasePluginInputError &&
          error.code === "invalid-result"
        ) {
          return {
            state: "failed",
            versions: {
              schemaVersion: SCHEMA_VERSION,
              storageVersion: STORAGE_VERSION,
              projectionGeneration: readiness.source.generation,
              sourceGeneration: readiness.source.generation,
            },
            error: { code: "storage-corruption" },
          };
        }
        throw error;
      }
    },

    async getReport(input: InsightsReportInput): Promise<InsightsReportResult> {
      try {
        assertInsightsQueryContract(input);
      } catch {
        return invalidQuery();
      }
      return getFirebaseInsightsReport(collections, namespace, input);
    },

    async pageReport(
      input: InsightsReportPageInput,
    ): Promise<InsightsReportPage> {
      try {
        assertInsightsQueryContract(input);
        if (input.cursor !== undefined) {
          assertInsightsCursorContract(input.cursor);
        }
      } catch {
        return invalidQuery();
      }
      return pageFirebaseInsightsReport(collections, namespace, input);
    },
  }) as RequiredInsightsModel;
