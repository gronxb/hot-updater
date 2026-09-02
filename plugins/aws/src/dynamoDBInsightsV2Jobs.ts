import { createHash } from "node:crypto";

import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  createUUIDv7,
  type BundleEventRow,
  type InsightsModel,
  type InsightsInstallationPage,
  type InsightsInstallationPageInput,
  type InsightsInstallationRow,
  type InsightsInitialPublishedInstallationPage,
  type InsightsInitialPublishedInstallationPageInput,
  type InsightsLiveInstallationPage,
  type InsightsLiveInstallationPageInput,
  type InsightsPinnedInstallationPage,
  type InsightsPinnedInstallationPageInput,
  type InsightsPublishedInstallationContinuation,
  type InsightsPublishedInstallationContinuationInput,
  type InsightsPublishedInstallationPage,
  type InsightsPublishedInstallationPageInput,
  type InsightsProjectedReadVersions,
  type InsightsReadVersions,
  type InsightsReportInput,
  type InsightsReportPage,
  type InsightsReportPageInput,
  type InsightsReportPublication,
  type InsightsReportQuery,
  type InsightsReportResult,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
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
  INSIGHTS_PAGE_MAX_BYTES,
  InsightsContractError,
  isCanonicalInsightsEventId,
  readInsightsInstallationPageInput,
  readInsightsReportPageQuery,
  readInsightsReportQuery,
} from "@hot-updater/plugin-core/internal";

import {
  assertDynamoDBInsightsTransactionBudget,
  createDynamoDBInsightsV2,
  DYNAMODB_INSIGHTS_PAGE_MAX_BYTES,
  DYNAMODB_INSIGHTS_STEP_MAX_BYTES,
  DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION,
  DYNAMODB_INSIGHTS_V2_PREFIX,
  DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS,
  DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
  DynamoDBInsightsV2BudgetError,
  DynamoDBInsightsV2HashCollisionError,
  DynamoDBInsightsV2InputError,
  DynamoDBInsightsV2StorageCorruptionError,
  type DynamoDBInsightsV2Store,
  dynamoDBInsightsInstallationHash,
  dynamoDBInsightsV2Namespace,
  getDynamoDBInsightsV2Readiness,
  isRetryableDynamoDBInsightsError,
  pageDynamoDBInsightsEvents,
  pageDynamoDBInsightsInstallationsCanonical,
  validateDynamoDBInsightsV2Event,
} from "./dynamoDBInsightsV2";

type TransactItem = NonNullable<
  TransactWriteCommandInput["TransactItems"]
>[number];

const JOB_PREFIX = `${DYNAMODB_INSIGHTS_V2_PREFIX}#jobs`;
const JOB_CURSOR_VERSION = 2;
const SOURCE_JOB_ID = "dynamodb-insights-v2-migration";
const MAX_JOB_SOURCE_ITEMS = 32;
const MAX_JOB_STEP_ITEMS = 96;
const textEncoder = new TextEncoder();

type JobKind = "search" | "report";
type JobStatus = "preparing" | "ready" | "failed";

type SearchQuery =
  | { readonly kind: "userId"; readonly userId: string }
  | { readonly kind: "contains"; readonly query: string };

type JobQuery = SearchQuery | InsightsReportQuery;

type JobCheckpoint =
  | {
      readonly phase: "source";
      readonly sourceShard: number;
      readonly afterSequence: number;
    }
  | {
      readonly phase: "installations";
      readonly shard: number;
      readonly afterHash: string | null;
    }
  | {
      readonly phase: "members";
      readonly task: number;
      readonly shard: number;
      readonly afterKey: string | null;
    }
  | {
      readonly phase: "fixed";
      readonly task: number;
      readonly nextBucketMs: number | null;
      readonly nextOrdinal: number;
    }
  | {
      readonly phase: "sort";
      readonly task: number;
      readonly shard: number;
      readonly afterKey: string | null;
      readonly runCount: number;
    }
  | {
      readonly phase: "merge";
      readonly task: number;
      readonly level: number;
      readonly inputRuns: number;
      readonly pair: number;
      readonly leftPosition: number;
      readonly rightPosition: number;
      readonly outputPosition: number;
    }
  | {
      readonly phase: "expand";
      readonly runPk: string;
      readonly bundlePosition: number;
      readonly nextOrdinal: number;
    }
  | { readonly phase: "finalize" };

type Job = {
  readonly pk: string;
  readonly sk: string;
  readonly item_type: "insights-job";
  readonly id: string;
  readonly job_kind: JobKind;
  readonly query_key: string;
  readonly query: JobQuery;
  readonly as_of_ms: number;
  readonly source_vector: readonly number[];
  readonly source_generation: string;
  readonly status: JobStatus;
  readonly revision: number;
  readonly checkpoint: JobCheckpoint;
  readonly previous_publication_id: string | null;
  readonly bounds: Readonly<Record<string, number>>;
  readonly total?: number;
  readonly completed_at_ms?: number;
  readonly summary?: unknown;
  readonly failure?: { readonly code: string; readonly message: string };
};

type Head = {
  readonly pk: string;
  readonly sk: string;
  readonly item_type: "insights-job-head";
  readonly query_key: string;
  readonly revision: number;
  readonly active_job_id: string | null;
  readonly publication_id: string | null;
};

type MemberTask = {
  readonly section: string;
  readonly metric: string;
};

type SortTask = MemberTask & {
  readonly publicSection:
    | "movementCohorts"
    | "bundleDistribution"
    | "activeBundleSeries";
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const padded = (value: number, width = 20): string =>
  value.toString().padStart(width, "0");
const jobControlKey = (id: string) => {
  const digest = sha256(id);
  return { pk: `${JOB_PREFIX}#control#${digest.slice(0, 2)}`, sk: id };
};
const headKey = (queryKey: string) => ({
  pk: `${JOB_PREFIX}#heads#${queryKey.slice(0, 2)}`,
  sk: queryKey,
});
const sourceClockKey = (sourceShard: number) => ({
  pk: `${DYNAMODB_INSIGHTS_V2_PREFIX}#source#${padded(sourceShard, 2)}`,
  sk: "!clock",
});
const sourcePartition = (sourceShard: number): string =>
  sourceClockKey(sourceShard).pk;
const sourceSortKey = (sequence: number): string => `e#${padded(sequence)}`;
const sourceLedgerLower = (sequence: number): string =>
  `${sourceSortKey(sequence)}#`;
const sourceLedgerUpper = (sequence: number): string =>
  `${sourceSortKey(sequence)}#\uffff`;
const latestPk = (
  jobId: string,
  kind: "overall" | "bucket",
  shard: string,
  bucketIndex?: number,
): string =>
  kind === "overall"
    ? `${JOB_PREFIX}#${jobId}#latest#overall#${shard}`
    : `${JOB_PREFIX}#${jobId}#latest#bucket#${padded(bucketIndex!, 2)}#${shard}`;
const latestKey = (
  jobId: string,
  installHash: string,
  bucketIndex: number,
) => ({
  pk: latestPk(
    jobId,
    bucketIndex === -1 ? "overall" : "bucket",
    installHash[0]!,
    bucketIndex,
  ),
  sk: installHash,
});
const memberPk = (
  jobId: string,
  task: MemberTask,
  installShard: string,
): string =>
  `${JOB_PREFIX}#${jobId}#members#${task.section}#${task.metric || "_"}#${installShard}`;
const dimensionIdentity = (label: string, bucketStartMs: number): string =>
  canonicalInsightsJson([label, bucketStartMs]);
const countKey = (
  jobId: string,
  task: MemberTask,
  label: string,
  bucketStartMs: number,
) => {
  const identity = dimensionIdentity(label, bucketStartMs);
  const digest = sha256(identity);
  return {
    pk: `${JOB_PREFIX}#${jobId}#counts#${task.section}#${task.metric || "_"}#${digest[0]}`,
    sk: digest,
  };
};
const countPartition = (
  jobId: string,
  task: MemberTask,
  shard: number,
): string =>
  `${JOB_PREFIX}#${jobId}#counts#${task.section}#${task.metric || "_"}#${shard.toString(16)}`;
const runPk = (
  jobId: string,
  task: number,
  level: number,
  run: number,
): string => `${JOB_PREFIX}#${jobId}#run#${task}#${level}#${run}`;
const runMetaKey = (
  jobId: string,
  task: number,
  level: number,
  run: number,
) => ({
  pk: `${JOB_PREFIX}#${jobId}#run-meta#${task}`,
  sk: `${padded(level, 4)}#${padded(run, 12)}`,
});
const sectionKey = (section: string, metric = ""): string =>
  canonicalInsightsJson([section, metric]);
const sectionMetaKey = (jobId: string, section: string, metric = "") => ({
  pk: `${JOB_PREFIX}#${jobId}#sections`,
  sk: sectionKey(section, metric),
});
const pagePk = (jobId: string, section: string, metric = ""): string =>
  `${JOB_PREFIX}#${jobId}#page#${sha256(sectionKey(section, metric)).slice(0, 16)}`;
const filterKey = (jobId: string, bundleId: string) => {
  const digest = sha256(canonicalInsightsJson(bundleId));
  return {
    pk: `${JOB_PREFIX}#${jobId}#filters#${digest[0]}`,
    sk: digest,
  };
};

const eventOrder = (row: Pick<BundleEventRow, "received_at_ms" | "id">) =>
  `${padded(row.received_at_ms, 16)}#${row.id}`;

type RequestBudgetStore = DynamoDBInsightsV2Store & {
  readonly requestsUsed: () => number;
};

const conditionalCancellationIndexes = (error: unknown): readonly number[] => {
  const reasons =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "CancellationReasons")
      : undefined;
  return Array.isArray(reasons)
    ? reasons.flatMap((reason, index) =>
        typeof reason === "object" &&
        reason !== null &&
        Reflect.get(reason, "Code") === "ConditionalCheckFailed"
          ? [index]
          : [],
      )
    : [];
};

const requestBudgetStore = (
  store: DynamoDBInsightsV2Store,
  maximum: number,
): RequestBudgetStore => {
  let requests = 0;
  return {
    tableName: store.tableName,
    insightsDatabaseNamespace: store.insightsDatabaseNamespace,
    requestsUsed: () => requests,
    client: {
      async send(command) {
        requests += 1;
        if (requests > maximum) {
          throw new DynamoDBInsightsV2BudgetError(
            "requests",
            requests,
            maximum,
          );
        }
        return store.client.send(command);
      },
    },
  };
};

const getStrong = async (
  store: DynamoDBInsightsV2Store,
  key: { readonly pk: string; readonly sk: string },
): Promise<Record<string, unknown> | undefined> =>
  (
    await store.client.send(
      new GetCommand({
        TableName: store.tableName,
        Key: key,
        ConsistentRead: true,
        ReturnConsumedCapacity: "TOTAL",
      }),
    )
  ).Item;

const batchGetStrong = async (
  store: DynamoDBInsightsV2Store,
  keys: readonly { readonly pk: string; readonly sk: string }[],
): Promise<readonly Record<string, unknown>[]> => {
  const output: Record<string, unknown>[] = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    let pending = keys.slice(offset, offset + 100);
    for (let attempt = 0; attempt < 5 && pending.length > 0; attempt++) {
      const result = await store.client.send(
        new BatchGetCommand({
          RequestItems: {
            [store.tableName]: { Keys: pending, ConsistentRead: true },
          },
          ReturnConsumedCapacity: "TOTAL",
        }),
      );
      output.push(...(result.Responses?.[store.tableName] ?? []));
      pending = result.UnprocessedKeys?.[store.tableName]?.Keys ?? [];
    }
    if (pending.length > 0) {
      throw new DynamoDBInsightsV2InputError(
        "DynamoDB Insights job left unprocessed keys",
      );
    }
  }
  return output;
};

const transactionToken = (
  store: DynamoDBInsightsV2Store,
  scope: string,
  actions: readonly TransactItem[],
): string =>
  sha256(
    `${dynamoDBInsightsV2Namespace(store)}\n${scope}\n${JSON.stringify(actions)}`,
  ).slice(0, 36);

const sendTransaction = async (
  store: DynamoDBInsightsV2Store,
  scope: string,
  actions: readonly TransactItem[],
): Promise<void> => {
  assertDynamoDBInsightsTransactionBudget(actions);
  await store.client.send(
    new TransactWriteCommand({
      ClientRequestToken: transactionToken(store, scope, actions),
      TransactItems: [...actions],
      ReturnConsumedCapacity: "TOTAL",
    }),
  );
};

const parseHead = (value: Record<string, unknown> | undefined): Head | null => {
  if (value === undefined) return null;
  if (
    value.item_type !== "insights-job-head" ||
    typeof value.pk !== "string" ||
    typeof value.sk !== "string" ||
    typeof value.query_key !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    (value.active_job_id !== null && typeof value.active_job_id !== "string") ||
    (value.publication_id !== null && typeof value.publication_id !== "string")
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights job head is invalid",
    );
  }
  return value as unknown as Head;
};

const parseJob = (value: Record<string, unknown> | undefined): Job | null => {
  if (value === undefined) return null;
  if (
    value.item_type !== "insights-job" ||
    typeof value.pk !== "string" ||
    typeof value.sk !== "string" ||
    typeof value.id !== "string" ||
    (value.job_kind !== "search" && value.job_kind !== "report") ||
    typeof value.query_key !== "string" ||
    typeof value.query !== "object" ||
    value.query === null ||
    !Number.isSafeInteger(value.as_of_ms) ||
    !Array.isArray(value.source_vector) ||
    value.source_vector.length !== DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS ||
    value.source_vector.some(
      (item) => !Number.isSafeInteger(item) || Number(item) < 0,
    ) ||
    typeof value.source_generation !== "string" ||
    (value.status !== "preparing" &&
      value.status !== "ready" &&
      value.status !== "failed") ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.checkpoint !== "object" ||
    value.checkpoint === null ||
    (value.previous_publication_id !== null &&
      typeof value.previous_publication_id !== "string") ||
    typeof value.bounds !== "object" ||
    value.bounds === null
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights job item is invalid",
    );
  }
  return value as unknown as Job;
};

const readJob = async (
  store: DynamoDBInsightsV2Store,
  id: string,
): Promise<Job | null> => parseJob(await getStrong(store, jobControlKey(id)));

const readSourceVector = async (
  store: DynamoDBInsightsV2Store,
): Promise<readonly number[]> => {
  const keys = Array.from(
    { length: DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS },
    (_, sourceShard) => sourceClockKey(sourceShard),
  );
  const items = await batchGetStrong(store, keys);
  const byKey = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const key = `${String(item.pk)}\n${String(item.sk)}`;
    if (byKey.has(key)) {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "DynamoDB Insights source clock is duplicated",
      );
    }
    byKey.set(key, item);
  }
  if (items.length !== keys.length) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights source clock set is incomplete",
    );
  }
  return keys.map((key) => {
    const item = byKey.get(`${key.pk}\n${key.sk}`);
    if (
      item === undefined ||
      item.pk !== key.pk ||
      item.sk !== key.sk ||
      item.item_type !== "source-clock" ||
      !Number.isSafeInteger(item.sequence) ||
      Number(item.sequence) < 0
    ) {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "DynamoDB Insights source clock is invalid",
      );
    }
    return Number(item.sequence);
  });
};

const sourceGeneration = (vector: readonly number[]): string =>
  `${DYNAMODB_INSIGHTS_V2_STORAGE_REVISION}:source:${sha256(canonicalInsightsJson(vector))}`;

function versions(
  source: string,
  projection: string,
): InsightsProjectedReadVersions;
function versions(
  source: string,
  projection: string | null,
): InsightsReadVersions & {
  readonly schemaVersion: string;
  readonly storageVersion: string;
  readonly sourceGeneration: string;
};
function versions(source: string, projection: string | null) {
  return {
    schemaVersion: String(DYNAMODB_INSIGHTS_V2_LAYOUT_VERSION),
    storageVersion: DYNAMODB_INSIGHTS_V2_STORAGE_REVISION,
    projectionGeneration: projection,
    sourceGeneration: source,
  };
}

const queryKey = (kind: JobKind, query: JobQuery): string =>
  sha256(
    canonicalInsightsJson([DYNAMODB_INSIGHTS_V2_STORAGE_REVISION, kind, query]),
  );

const sameStoredQuery = (left: JobQuery, right: JobQuery): boolean =>
  canonicalInsightsJson(left) === canonicalInsightsJson(right);

const normalizeSearch = (
  input: InsightsPublishedInstallationPageInput,
): SearchQuery => {
  if (input.kind === "contains") {
    return { kind: input.kind, query: input.query.toLowerCase() };
  }
  return { kind: input.kind, userId: input.userId };
};

const nextSafeRevision = (revision: number): number => {
  if (revision === Number.MAX_SAFE_INTEGER) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights revision is exhausted",
    );
  }
  return revision + 1;
};

type Reservation =
  | { readonly state: "ready"; readonly job: Job }
  | { readonly state: "failed"; readonly job: Job }
  | {
      readonly state: "preparing";
      readonly job: Job;
      readonly previous: Job | null;
    };

const jobPut = (
  store: DynamoDBInsightsV2Store,
  job: Job,
  expectedRevision?: number,
): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: job,
    ConditionExpression:
      expectedRevision === undefined
        ? "attribute_not_exists(#pk)"
        : "#revision = :revision",
    ExpressionAttributeNames: {
      ...(expectedRevision === undefined ? { "#pk": "pk" } : {}),
      ...(expectedRevision === undefined ? {} : { "#revision": "revision" }),
    },
    ...(expectedRevision === undefined
      ? {}
      : { ExpressionAttributeValues: { ":revision": expectedRevision } }),
  },
});

const headPut = (
  store: DynamoDBInsightsV2Store,
  head: Head,
  expectedRevision: number | null,
): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: head,
    ConditionExpression:
      expectedRevision === null
        ? "attribute_not_exists(#pk)"
        : "#revision = :revision",
    ExpressionAttributeNames: {
      ...(expectedRevision === null ? { "#pk": "pk" } : {}),
      ...(expectedRevision === null ? {} : { "#revision": "revision" }),
    },
    ...(expectedRevision === null
      ? {}
      : { ExpressionAttributeValues: { ":revision": expectedRevision } }),
  },
});

const reserveJob = async (
  store: DynamoDBInsightsV2Store,
  kind: JobKind,
  query: JobQuery,
  minAsOfMs: number,
): Promise<Reservation> => {
  const key = queryKey(kind, query);
  for (let attempt = 0; attempt < 6; attempt++) {
    const head = parseHead(await getStrong(store, headKey(key)));
    if (head?.active_job_id !== null && head?.active_job_id !== undefined) {
      const active = await readJob(store, head.active_job_id);
      if (
        active === null ||
        active.query_key !== key ||
        !sameStoredQuery(active.query, query)
      ) {
        throw new DynamoDBInsightsV2InputError(
          "DynamoDB Insights active job is missing",
        );
      }
      const previous =
        head.publication_id === null
          ? null
          : await readJob(store, head.publication_id);
      return active.status === "failed"
        ? { state: "failed", job: active }
        : { state: "preparing", job: active, previous };
    }
    const current =
      head?.publication_id === null || head?.publication_id === undefined
        ? null
        : await readJob(store, head.publication_id);
    if (current !== null && !sameStoredQuery(current.query, query)) {
      throw new DynamoDBInsightsV2HashCollisionError(key);
    }
    if (
      current !== null &&
      current.status === "ready" &&
      current.as_of_ms >= minAsOfMs
    ) {
      return { state: "ready", job: current };
    }
    const vector = await readSourceVector(store);
    const id = createUUIDv7();
    const asOfMs = Date.now();
    const job: Job = {
      ...jobControlKey(id),
      item_type: "insights-job",
      id,
      job_kind: kind,
      query_key: key,
      query,
      as_of_ms: asOfMs,
      source_vector: vector,
      source_generation: sourceGeneration(vector),
      status: "preparing",
      revision: 1,
      checkpoint: { phase: "source", sourceShard: 0, afterSequence: 0 },
      previous_publication_id: current?.status === "ready" ? current.id : null,
      bounds: {},
    };
    const nextHead: Head = {
      ...headKey(key),
      item_type: "insights-job-head",
      query_key: key,
      revision: nextSafeRevision(head?.revision ?? 0),
      active_job_id: id,
      publication_id: current?.status === "ready" ? current.id : null,
    };
    const clockConditions = vector.map(
      (sequence, sourceShard): TransactItem => ({
        ConditionCheck: {
          TableName: store.tableName,
          Key: sourceClockKey(sourceShard),
          ConditionExpression: "#type = :type AND #sequence = :sequence",
          ExpressionAttributeNames: {
            "#type": "item_type",
            "#sequence": "sequence",
          },
          ExpressionAttributeValues: {
            ":type": "source-clock",
            ":sequence": sequence,
          },
        },
      }),
    );
    try {
      await sendTransaction(store, `reserve:${key}:${id}`, [
        ...clockConditions,
        jobPut(store, job),
        headPut(store, nextHead, head?.revision ?? null),
      ]);
      return { state: "preparing", job, previous: current };
    } catch (error) {
      const conditional = conditionalCancellationIndexes(error);
      if (
        conditional.length > 0 &&
        conditional.every(
          (index) =>
            index < DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS ||
            index === DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS + 1,
        )
      ) {
        continue;
      }
      if (conditional.length > 0) {
        throw new DynamoDBInsightsV2StorageCorruptionError(
          "DynamoDB Insights job reservation collided with persisted storage",
        );
      }
      if (!isRetryableDynamoDBInsightsError(error)) throw error;
    }
  }
  throw new DynamoDBInsightsV2InputError(
    "DynamoDB Insights job reservation did not converge",
  );
};

const publication = (job: Job): InsightsReportPublication => {
  if (
    job.job_kind !== "report" ||
    job.status !== "ready" ||
    job.completed_at_ms === undefined
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights publication is not ready",
    );
  }
  const base = {
    id: job.id,
    asOfMs: job.as_of_ms,
    completedAtMs: job.completed_at_ms,
    sourceGeneration: job.source_generation,
    accuracy: "exact" as const,
  };
  if (job.query.kind === "bundleSummaries") {
    return { ...base, kind: job.query.kind, summary: job.summary as any };
  }
  if (job.query.kind === "bundleDetail") {
    return { ...base, kind: job.query.kind, summary: job.summary as any };
  }
  if (job.query.kind === "installationOverview") {
    return { ...base, kind: job.query.kind, summary: job.summary as any };
  }
  if (job.query.kind === "activeOverview") {
    return { ...base, kind: job.query.kind, summary: job.summary as any };
  }
  throw new DynamoDBInsightsV2InputError("Invalid report publication query");
};

const searchPublication = (job: Job) => {
  if (
    job.job_kind !== "search" ||
    job.status !== "ready" ||
    job.completed_at_ms === undefined
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights search publication is not ready",
    );
  }
  return {
    id: job.id,
    asOfMs: job.as_of_ms,
    completedAtMs: job.completed_at_ms,
    sourceGeneration: job.source_generation,
    accuracy: "exact" as const,
  };
};

const preparingResult = (job: Job) => {
  const result = {
    state: "preparing" as const,
    versions: versions(job.source_generation, job.id),
    job: { id: job.id },
  };
  assertInsightsPreparingReadContract(result);
  return result;
};

const failedResult = (job: Job) => {
  const migrationPoison =
    job.failure?.code === "DynamoDBInsightsV2StorageCorruptionError";
  const result = {
    state: "failed" as const,
    versions: versions(job.source_generation, job.id),
    error: {
      code: migrationPoison
        ? ("migration-poison" as const)
        : ("preparation-failed" as const),
      jobId: job.id,
    },
  };
  assertInsightsFailedReadContract(result);
  return result;
};

const storageCorruptionResult = (job?: Job) => {
  const result = {
    state: "failed" as const,
    versions:
      job === undefined
        ? {
            schemaVersion: null,
            storageVersion: null,
            projectionGeneration: null,
            sourceGeneration: null,
          }
        : versions(job.source_generation, job.id),
    error: { code: "storage-corruption" as const },
  };
  assertInsightsFailedReadContract(result);
  return result;
};

const isPublicationCorruption = (error: unknown): boolean =>
  error instanceof DynamoDBInsightsV2InputError ||
  error instanceof DynamoDBInsightsV2HashCollisionError ||
  error instanceof DynamoDBInsightsV2StorageCorruptionError ||
  error instanceof InsightsContractError;

const migrationState = async (store: DynamoDBInsightsV2Store) => {
  const readiness = await getDynamoDBInsightsV2Readiness(store);
  if (readiness.source === "ready") return null;
  const vector = await readSourceVector(store);
  const source = sourceGeneration(vector);
  if (readiness.source === "failed") {
    const result = {
      state: "failed" as const,
      versions: versions(source, null),
      error: { code: "migration-poison" as const, jobId: SOURCE_JOB_ID },
    };
    assertInsightsFailedReadContract(result);
    return result;
  }
  const result = {
    state: "preparing" as const,
    versions: versions(source, null),
    job: { id: SOURCE_JOB_ID },
  };
  assertInsightsPreparingReadContract(result);
  return result;
};

type SourceItem = {
  readonly pk: string;
  readonly sk: string;
  readonly source_shard: number;
  readonly source_sequence: number;
  readonly event_id: string;
  readonly row_digest: string;
  readonly raw_bytes: number;
  readonly row: BundleEventRow;
};

const parseSourceItem = (value: Record<string, unknown>): SourceItem => {
  if (
    value.item_type !== "source-event" ||
    typeof value.pk !== "string" ||
    typeof value.sk !== "string" ||
    !Number.isSafeInteger(value.source_shard) ||
    Number(value.source_shard) < 0 ||
    Number(value.source_shard) >= DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS ||
    !Number.isSafeInteger(value.source_sequence) ||
    Number(value.source_sequence) < 1 ||
    typeof value.event_id !== "string" ||
    typeof value.row_digest !== "string" ||
    !Number.isSafeInteger(value.raw_bytes) ||
    typeof value.row !== "object" ||
    value.row === null
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights job source is invalid",
    );
  }
  let event: ReturnType<typeof validateDynamoDBInsightsV2Event>;
  try {
    event = validateDynamoDBInsightsV2Event(value.row as BundleEventRow);
  } catch (cause) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights job source event is invalid",
      { cause },
    );
  }
  const expectedPk = sourcePartition(Number(value.source_shard));
  const expectedSk = `${sourceSortKey(Number(value.source_sequence))}#${event.row.id}`;
  if (
    value.pk !== expectedPk ||
    value.sk !== expectedSk ||
    event.row.id !== value.event_id ||
    event.digest !== value.row_digest ||
    event.byteLength !== value.raw_bytes
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights job source checksum is invalid",
    );
  }
  return value as unknown as SourceItem;
};

const installationRow = (row: BundleEventRow): InsightsInstallationRow => ({
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

const searchMatches = (query: SearchQuery, row: BundleEventRow): boolean => {
  if (query.kind === "userId") return row.user_id === query.userId;
  return [row.install_id, row.user_id, row.username].some(
    (value) =>
      typeof value === "string" && value.toLowerCase().includes(query.query),
  );
};

type LatestCandidate = {
  readonly key: { readonly pk: string; readonly sk: string };
  readonly installId: string;
  readonly installHash: string;
  readonly bucketIndex: number;
  readonly row: BundleEventRow;
  readonly rawBytes: number;
};

const latestCandidate = (
  job: Job,
  row: BundleEventRow,
  rawBytes: number,
  bucketIndex: number,
): LatestCandidate => {
  const installHash = dynamoDBInsightsInstallationHash(row.install_id);
  return {
    key: latestKey(job.id, installHash, bucketIndex),
    installId: row.install_id,
    installHash,
    bucketIndex,
    row,
    rawBytes,
  };
};

const reduceLatest = (
  values: readonly LatestCandidate[],
): readonly LatestCandidate[] => {
  const byKey = new Map<string, LatestCandidate>();
  for (const value of values) {
    const key = `${value.key.pk}\n${value.key.sk}`;
    const current = byKey.get(key);
    if (current !== undefined && current.installId !== value.installId) {
      throw new DynamoDBInsightsV2HashCollisionError(value.installId);
    }
    if (
      current === undefined ||
      eventOrder(current.row) < eventOrder(value.row)
    ) {
      byKey.set(key, value);
    }
  }
  return [...byKey.values()];
};

const latestActions = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  candidates: readonly LatestCandidate[],
): Promise<readonly TransactItem[]> => {
  const reduced = reduceLatest(candidates);
  const current = await batchGetStrong(
    store,
    reduced.map((candidate) => candidate.key),
  );
  const byKey = new Map(
    current.map((item) => [`${String(item.pk)}\n${String(item.sk)}`, item]),
  );
  return reduced.flatMap((candidate) => {
    const existing = byKey.get(`${candidate.key.pk}\n${candidate.key.sk}`);
    if (
      existing !== undefined &&
      (existing.item_type !== "insights-job-latest" ||
        existing.job_id !== job.id ||
        existing.install_id !== candidate.installId ||
        existing.install_hash !== candidate.installHash ||
        existing.bucket_index !== candidate.bucketIndex ||
        typeof existing.event_order !== "string")
    ) {
      if (existing.install_id !== candidate.installId) {
        throw new DynamoDBInsightsV2HashCollisionError(candidate.installId);
      }
      throw new DynamoDBInsightsV2InputError(
        "DynamoDB Insights job latest item is invalid",
      );
    }
    if (
      existing !== undefined &&
      String(existing.event_order) >= eventOrder(candidate.row)
    ) {
      return [];
    }
    return [
      {
        Put: {
          TableName: store.tableName,
          Item: {
            ...candidate.key,
            item_type: "insights-job-latest",
            job_id: job.id,
            install_id: candidate.installId,
            install_hash: candidate.installHash,
            bucket_index: candidate.bucketIndex,
            event_order: eventOrder(candidate.row),
            raw_bytes: candidate.rawBytes,
            row: candidate.row,
          },
          ConditionExpression:
            "(attribute_not_exists(#pk) OR #install = :install) AND (attribute_not_exists(#order) OR #order < :order)",
          ExpressionAttributeNames: {
            "#pk": "pk",
            "#install": "install_id",
            "#order": "event_order",
          },
          ExpressionAttributeValues: {
            ":install": candidate.installId,
            ":order": eventOrder(candidate.row),
          },
        },
      } satisfies TransactItem,
    ];
  });
};

type Member = {
  readonly task: MemberTask;
  readonly label: string;
  readonly bucketStartMs: number;
  readonly installId: string;
  readonly installHash: string;
};

const member = (
  task: MemberTask,
  label: string,
  bucketStartMs: number,
  installId: string,
): Member => ({
  task,
  label,
  bucketStartMs,
  installId,
  installHash: dynamoDBInsightsInstallationHash(installId),
});

const memberIdentity = (value: Member): string =>
  canonicalInsightsJson([
    value.task.section,
    value.task.metric,
    value.label,
    value.bucketStartMs,
  ]);

const memberActions = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  values: readonly Member[],
): Promise<readonly TransactItem[]> => {
  const unique = new Map<string, Member>();
  for (const value of values) {
    const dimension = sha256(memberIdentity(value));
    const key = `${memberPk(job.id, value.task, value.installHash[0]!)}\n${dimension}#${value.installHash}`;
    const current = unique.get(key);
    if (
      current !== undefined &&
      (current.installId !== value.installId ||
        memberIdentity(current) !== memberIdentity(value))
    ) {
      throw new DynamoDBInsightsV2HashCollisionError(value.installId);
    }
    unique.set(key, value);
  }
  const entries = [...unique.values()];
  const existing = await batchGetStrong(
    store,
    entries.map((value) => {
      const dimension = sha256(memberIdentity(value));
      return {
        pk: memberPk(job.id, value.task, value.installHash[0]!),
        sk: `${dimension}#${value.installHash}`,
      };
    }),
  );
  for (const item of existing) {
    const identity = String(item.dimension_identity);
    const expected = entries.find(
      (value) =>
        memberIdentity(value) === identity &&
        value.installHash === item.install_hash,
    );
    if (
      expected === undefined ||
      item.item_type !== "insights-job-member" ||
      item.job_id !== job.id ||
      item.section !== expected.task.section ||
      item.metric !== expected.task.metric ||
      item.install_id !== expected.installId
    ) {
      throw new DynamoDBInsightsV2HashCollisionError(
        typeof item.install_id === "string" ? item.install_id : "member",
      );
    }
  }
  return entries.map((value) => {
    const identity = memberIdentity(value);
    const dimension = sha256(identity);
    return {
      Put: {
        TableName: store.tableName,
        Item: {
          pk: memberPk(job.id, value.task, value.installHash[0]!),
          sk: `${dimension}#${value.installHash}`,
          item_type: "insights-job-member",
          job_id: job.id,
          section: value.task.section,
          metric: value.task.metric,
          dimension_identity: identity,
          label: value.label,
          bucket_start_ms: value.bucketStartMs,
          install_id: value.installId,
          install_hash: value.installHash,
        },
        ConditionExpression:
          "attribute_not_exists(#pk) OR (#identity = :identity AND #install = :install)",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#identity": "dimension_identity",
          "#install": "install_id",
        },
        ExpressionAttributeValues: {
          ":identity": identity,
          ":install": value.installId,
        },
      },
    } satisfies TransactItem;
  });
};

const nextAfterSource = (job: Job): JobCheckpoint => {
  if (job.job_kind === "search") {
    return { phase: "members", task: 0, shard: 0, afterKey: null };
  }
  if (
    job.query.kind === "installationOverview" ||
    job.query.kind === "activeOverview"
  ) {
    return { phase: "installations", shard: 0, afterHash: null };
  }
  return { phase: "members", task: 0, shard: 0, afterKey: null };
};

const memberTasks = (job: Job): readonly MemberTask[] => {
  if (job.job_kind === "search") return [{ section: "search", metric: "" }];
  switch (job.query.kind) {
    case "bundleSummaries":
      return [
        { section: "summary", metric: "installed" },
        { section: "summary", metric: "recovered" },
      ];
    case "bundleDetail":
      return [
        { section: "summary", metric: "installed" },
        { section: "summary", metric: "recovered" },
        { section: "movementSeries", metric: "installed" },
        { section: "movementSeries", metric: "recovered" },
        { section: "movementCohorts", metric: "installed" },
        { section: "movementCohorts", metric: "recovered" },
      ];
    case "installationOverview":
      return [
        { section: "installations", metric: "" },
        { section: "bundleDistribution", metric: "" },
      ];
    case "activeOverview":
      return [
        { section: "installations", metric: "" },
        { section: "bundleDistribution", metric: "" },
        { section: "activeSeries", metric: "" },
        { section: "activeBundleSeries", metric: "" },
        { section: "activeBundleTotals", metric: "" },
      ];
    default:
      throw new DynamoDBInsightsV2InputError("Invalid job member query");
  }
};

const fixedTasks = (job: Job): readonly MemberTask[] => {
  if (job.job_kind !== "report") return [];
  if (job.query.kind === "bundleDetail") {
    return [
      { section: "movementSeries", metric: "installed" },
      { section: "movementSeries", metric: "recovered" },
    ];
  }
  return job.query.kind === "activeOverview"
    ? [{ section: "activeSeries", metric: "" }]
    : [];
};

const sortTasks = (job: Job): readonly SortTask[] => {
  if (job.job_kind !== "report") return [];
  if (job.query.kind === "bundleDetail") {
    return [
      {
        section: "movementCohorts",
        metric: "installed",
        publicSection: "movementCohorts",
      },
      {
        section: "movementCohorts",
        metric: "recovered",
        publicSection: "movementCohorts",
      },
    ];
  }
  if (job.query.kind === "installationOverview") {
    return [
      {
        section: "bundleDistribution",
        metric: "",
        publicSection: "bundleDistribution",
      },
    ];
  }
  if (job.query.kind === "activeOverview") {
    return [
      {
        section: "bundleDistribution",
        metric: "",
        publicSection: "bundleDistribution",
      },
      {
        section: "activeBundleTotals",
        metric: "",
        publicSection: "activeBundleSeries",
      },
    ];
  }
  return [];
};

const firstAfterMembers = (job: Job): JobCheckpoint =>
  fixedTasks(job).length > 0
    ? { phase: "fixed", task: 0, nextBucketMs: null, nextOrdinal: 0 }
    : sortTasks(job).length > 0
      ? { phase: "sort", task: 0, shard: 0, afterKey: null, runCount: 0 }
      : { phase: "finalize" };

const jobWith = (job: Job, value: Partial<Job>): Job => ({
  ...job,
  ...value,
  revision: nextSafeRevision(job.revision),
});

const commitStep = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  next: Job,
  actions: readonly TransactItem[],
): Promise<boolean> => {
  try {
    await sendTransaction(store, `job:${job.id}:${job.revision}`, [
      ...actions,
      jobPut(store, next, job.revision),
    ]);
    return true;
  } catch (error) {
    const current = await readJob(store, job.id);
    if (current !== null && current.revision > job.revision) return false;
    if (conditionalCancellationIndexes(error).length > 0) {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "DynamoDB Insights job step collided with persisted storage",
      );
    }
    throw error;
  }
};

const failJob = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  error: unknown,
): Promise<void> => {
  const next = jobWith(job, {
    status: "failed",
    failure: {
      code:
        error instanceof Error && error.name
          ? error.name
          : "DynamoDBInsightsJobFailure",
      message:
        error instanceof Error ? error.message.slice(0, 1_024) : "Job failed",
    },
  });
  await commitStep(store, job, next, []);
};

const movementMembers = (job: Job, row: BundleEventRow): readonly Member[] => {
  if (
    job.job_kind !== "report" ||
    (job.query.kind !== "bundleSummaries" &&
      job.query.kind !== "bundleDetail") ||
    (row.type !== "UPDATE_APPLIED" && row.type !== "RECOVERED")
  ) {
    return [];
  }
  const projection = createInsightsReportProjection(job.query, job.as_of_ms);
  const value = projection.project(row);
  if (value?.kind !== "movement") return [];
  const metric = value.metric;
  const values: Member[] = [
    member({ section: "summary", metric }, value.bundleId, -1, value.installId),
  ];
  if (job.query.kind === "bundleDetail") {
    values.push(
      member(
        { section: "movementSeries", metric },
        "",
        value.bucketStartMs,
        value.installId,
      ),
      member(
        { section: "movementCohorts", metric },
        value.cohort,
        -1,
        value.installId,
      ),
    );
  }
  return values;
};

const sourceLatest = (
  job: Job,
  source: SourceItem,
): readonly LatestCandidate[] => {
  if (source.row.received_at_ms >= job.as_of_ms) return [];
  if (job.job_kind === "search") {
    return [latestCandidate(job, source.row, source.raw_bytes, -1)];
  }
  if (
    job.query.kind !== "installationOverview" &&
    job.query.kind !== "activeOverview"
  ) {
    return [];
  }
  const projection = createInsightsReportProjection(job.query, job.as_of_ms);
  const projected = projection.project(source.row);
  if (projected?.kind !== "installation") return [];
  const values = [latestCandidate(job, source.row, source.raw_bytes, -1)];
  if (projected.bucketStartMs !== null) {
    const bucketIndex =
      (projected.bucketStartMs - projection.firstBucketMs!) /
      projection.bucketSizeMs;
    if (
      !Number.isSafeInteger(bucketIndex) ||
      bucketIndex < 0 ||
      bucketIndex > 29
    ) {
      throw new DynamoDBInsightsV2InputError(
        "DynamoDB Insights active bucket is invalid",
      );
    }
    values.push(
      latestCandidate(job, source.row, source.raw_bytes, bucketIndex),
    );
  }
  return values;
};

const stepSource = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  maxItems: number,
): Promise<number> => {
  if (job.checkpoint.phase !== "source") {
    throw new DynamoDBInsightsV2InputError("Invalid source checkpoint");
  }
  const checkpoint = job.checkpoint;
  const boundary = job.source_vector[checkpoint.sourceShard]!;
  if (checkpoint.afterSequence >= boundary) {
    const done =
      checkpoint.sourceShard + 1 === DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS;
    const next = jobWith(job, {
      checkpoint: done
        ? nextAfterSource(job)
        : {
            phase: "source",
            sourceShard: checkpoint.sourceShard + 1,
            afterSequence: 0,
          },
    });
    await commitStep(store, job, next, []);
    return 0;
  }
  const limit = Math.min(maxItems, MAX_JOB_SOURCE_ITEMS);
  const result = await store.client.send(
    new QueryCommand({
      TableName: store.tableName,
      ConsistentRead: true,
      KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :after AND :boundary",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": sourcePartition(checkpoint.sourceShard),
        ":after": sourceLedgerLower(checkpoint.afterSequence + 1),
        ":boundary": sourceLedgerUpper(boundary),
      },
      Limit: limit,
      ScanIndexForward: true,
      ReturnConsumedCapacity: "TOTAL",
    }),
  );
  const sources: SourceItem[] = (result.Items ?? []).map(parseSourceItem);
  if (sources.length === 0) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights captured source has a gap",
    );
  }
  let expected = checkpoint.afterSequence + 1;
  for (const source of sources) {
    if (
      source.source_shard !== checkpoint.sourceShard ||
      source.source_sequence !== expected ||
      source.source_sequence > boundary
    ) {
      throw new DynamoDBInsightsV2InputError(
        "DynamoDB Insights captured source is not contiguous",
      );
    }
    expected += 1;
  }
  const bytes = sources.reduce((sum, source) => sum + source.raw_bytes, 0);
  if (bytes > DYNAMODB_INSIGHTS_STEP_MAX_BYTES) {
    throw new DynamoDBInsightsV2BudgetError(
      "step-bytes",
      bytes,
      DYNAMODB_INSIGHTS_STEP_MAX_BYTES,
    );
  }
  const latest = sources.flatMap((source) => sourceLatest(job, source));
  const members: Member[] = sources.flatMap((source) => {
    if (source.row.received_at_ms >= job.as_of_ms) return [];
    if (job.job_kind === "search") {
      return searchMatches(job.query as SearchQuery, source.row)
        ? [
            member(
              { section: "search", metric: "" },
              "",
              -1,
              source.row.install_id,
            ),
          ]
        : [];
    }
    return movementMembers(job, source.row);
  });
  const actions = [
    ...(await latestActions(store, job, latest)),
    ...(await memberActions(store, job, members)),
  ];
  const last = sources.at(-1)!.source_sequence;
  const shardDone = last === boundary;
  const allDone =
    shardDone &&
    checkpoint.sourceShard + 1 === DYNAMODB_INSIGHTS_V2_SOURCE_SHARDS;
  const next = jobWith(job, {
    checkpoint: allDone
      ? nextAfterSource(job)
      : shardDone
        ? {
            phase: "source",
            sourceShard: checkpoint.sourceShard + 1,
            afterSequence: 0,
          }
        : {
            phase: "source",
            sourceShard: checkpoint.sourceShard,
            afterSequence: last,
          },
  });
  await commitStep(store, job, next, actions);
  return sources.length;
};

const parseLatest = (
  value: Record<string, unknown>,
  job: Job,
): LatestCandidate => {
  if (
    value.item_type !== "insights-job-latest" ||
    value.job_id !== job.id ||
    typeof value.install_id !== "string" ||
    typeof value.install_hash !== "string" ||
    !Number.isSafeInteger(value.bucket_index) ||
    typeof value.event_order !== "string" ||
    !Number.isSafeInteger(value.raw_bytes) ||
    typeof value.row !== "object" ||
    value.row === null ||
    typeof value.pk !== "string" ||
    typeof value.sk !== "string"
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights job latest record is invalid",
    );
  }
  const event = validateDynamoDBInsightsV2Event(value.row as BundleEventRow);
  if (
    event.row.install_id !== value.install_id ||
    eventOrder(event.row) !== value.event_order ||
    event.byteLength !== value.raw_bytes ||
    dynamoDBInsightsInstallationHash(event.row.install_id) !==
      value.install_hash ||
    value.sk !== value.install_hash
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights job latest checksum is invalid",
    );
  }
  return {
    key: { pk: value.pk, sk: value.sk },
    installId: event.row.install_id,
    installHash: value.install_hash,
    bucketIndex: Number(value.bucket_index),
    row: event.row,
    rawBytes: event.byteLength,
  };
};

const stepInstallations = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  maxItems: number,
): Promise<number> => {
  if (
    job.checkpoint.phase !== "installations" ||
    job.job_kind !== "report" ||
    (job.query.kind !== "installationOverview" &&
      job.query.kind !== "activeOverview")
  ) {
    throw new DynamoDBInsightsV2InputError(
      "Invalid installation-reduction checkpoint",
    );
  }
  const checkpoint = job.checkpoint;
  const projection = createInsightsReportProjection(job.query, job.as_of_ms);
  const bucketCount =
    job.query.kind === "activeOverview"
      ? Math.floor(
          (projection.lastBucketMs - projection.firstBucketMs!) /
            projection.bucketSizeMs,
        ) + 1
      : 0;
  const limit = Math.min(
    maxItems,
    Math.max(1, Math.floor(96 / Math.max(2 + bucketCount * 3, 2))),
  );
  const result = await store.client.send(
    new QueryCommand({
      TableName: store.tableName,
      ConsistentRead: true,
      KeyConditionExpression:
        checkpoint.afterHash === null
          ? "#pk = :pk"
          : "#pk = :pk AND #sk > :after",
      ExpressionAttributeNames: {
        "#pk": "pk",
        ...(checkpoint.afterHash === null ? {} : { "#sk": "sk" }),
      },
      ExpressionAttributeValues: {
        ":pk": latestPk(job.id, "overall", checkpoint.shard.toString(16)),
        ...(checkpoint.afterHash === null
          ? {}
          : { ":after": checkpoint.afterHash }),
      },
      Limit: limit,
      ScanIndexForward: true,
      ReturnConsumedCapacity: "TOTAL",
    }),
  );
  const latest: LatestCandidate[] = (result.Items ?? []).map(
    (item: Record<string, unknown>) => parseLatest(item, job),
  );
  const bucketKeys =
    bucketCount === 0
      ? []
      : latest.flatMap((row) =>
          Array.from({ length: bucketCount }, (_, index) =>
            latestKey(job.id, row.installHash, index),
          ),
        );
  const buckets = await batchGetStrong(store, bucketKeys);
  const byInstall = new Map<string, LatestCandidate[]>();
  for (const item of buckets) {
    const row = parseLatest(item, job);
    const values = byInstall.get(row.installHash) ?? [];
    values.push(row);
    byInstall.set(row.installHash, values);
  }
  const members: Member[] = [];
  for (const current of latest) {
    if (
      job.query.kind === "activeOverview" &&
      job.query.userId !== undefined &&
      current.row.user_id !== job.query.userId
    ) {
      continue;
    }
    const activeBuckets = byInstall.get(current.installHash) ?? [];
    if (job.query.kind === "activeOverview" && activeBuckets.length === 0) {
      continue;
    }
    members.push(
      member(
        { section: "installations", metric: "" },
        "",
        -1,
        current.installId,
      ),
      member(
        { section: "bundleDistribution", metric: "" },
        current.row.to_bundle_id,
        -1,
        current.installId,
      ),
    );
    if (job.query.kind !== "activeOverview") continue;
    for (const bucket of activeBuckets) {
      const bucketStartMs =
        projection.firstBucketMs! +
        bucket.bucketIndex * projection.bucketSizeMs;
      members.push(
        member(
          { section: "activeSeries", metric: "" },
          "",
          bucketStartMs,
          current.installId,
        ),
        member(
          { section: "activeBundleSeries", metric: "" },
          bucket.row.to_bundle_id,
          bucketStartMs,
          current.installId,
        ),
        member(
          { section: "activeBundleTotals", metric: "" },
          bucket.row.to_bundle_id,
          -1,
          canonicalInsightsJson([current.installId, bucketStartMs]),
        ),
      );
    }
  }
  const exhausted = result.LastEvaluatedKey === undefined;
  const lastHash = latest.at(-1)?.installHash ?? checkpoint.afterHash;
  const allDone = exhausted && checkpoint.shard === 15;
  const next = jobWith(job, {
    checkpoint: allDone
      ? { phase: "members", task: 0, shard: 0, afterKey: null }
      : exhausted
        ? {
            phase: "installations",
            shard: checkpoint.shard + 1,
            afterHash: null,
          }
        : {
            phase: "installations",
            shard: checkpoint.shard,
            afterHash: lastHash,
          },
  });
  await commitStep(store, job, next, await memberActions(store, job, members));
  return latest.length;
};

type ParsedMember = Member & { readonly sk: string };

const parseMember = (
  value: Record<string, unknown>,
  job: Job,
  task: MemberTask,
): ParsedMember => {
  if (
    value.item_type !== "insights-job-member" ||
    value.job_id !== job.id ||
    value.section !== task.section ||
    value.metric !== task.metric ||
    typeof value.dimension_identity !== "string" ||
    typeof value.label !== "string" ||
    !Number.isSafeInteger(value.bucket_start_ms) ||
    typeof value.install_id !== "string" ||
    typeof value.install_hash !== "string" ||
    typeof value.sk !== "string"
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights job member is invalid",
    );
  }
  const parsed = member(
    task,
    value.label,
    Number(value.bucket_start_ms),
    value.install_id,
  );
  if (
    parsed.installHash !== value.install_hash ||
    memberIdentity(parsed) !== value.dimension_identity ||
    value.sk !== `${sha256(value.dimension_identity)}#${parsed.installHash}`
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights job member checksum is invalid",
    );
  }
  return { ...parsed, sk: value.sk };
};

const countActions = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  task: MemberTask,
  members: readonly ParsedMember[],
): Promise<readonly TransactItem[]> => {
  const groups = new Map<
    string,
    { label: string; bucket: number; count: number }
  >();
  for (const value of members) {
    const identity = dimensionIdentity(value.label, value.bucketStartMs);
    const group = groups.get(identity);
    if (group === undefined) {
      groups.set(identity, {
        label: value.label,
        bucket: value.bucketStartMs,
        count: 1,
      });
    } else {
      group.count += 1;
    }
  }
  const entries = [...groups.entries()];
  const dimensionsByKey = new Map<string, string>();
  for (const [identity, value] of entries) {
    const key = countKey(job.id, task, value.label, value.bucket);
    const physical = `${key.pk}\n${key.sk}`;
    const previous = dimensionsByKey.get(physical);
    if (previous !== undefined && previous !== identity) {
      throw new DynamoDBInsightsV2HashCollisionError(value.label);
    }
    dimensionsByKey.set(physical, identity);
  }
  const existing = await batchGetStrong(
    store,
    entries.map(([, value]) =>
      countKey(job.id, task, value.label, value.bucket),
    ),
  );
  for (const item of existing) {
    parseCount(item, job, task);
  }
  return entries.map(([identity, value]) => ({
    Update: {
      TableName: store.tableName,
      Key: countKey(job.id, task, value.label, value.bucket),
      UpdateExpression:
        "SET #item = :item, #job = :job, #section = :section, #metric = :metric, #identity = :identity, #label = :label, #bucket = :bucket ADD #value :increment",
      ConditionExpression:
        "attribute_not_exists(#pk) OR (#identity = :identity AND #job = :job)",
      ExpressionAttributeNames: {
        "#pk": "pk",
        "#item": "item_type",
        "#job": "job_id",
        "#section": "section",
        "#metric": "metric",
        "#identity": "dimension_identity",
        "#label": "label",
        "#bucket": "bucket_start_ms",
        "#value": "value",
      },
      ExpressionAttributeValues: {
        ":item": "insights-job-count",
        ":job": job.id,
        ":section": task.section,
        ":metric": task.metric,
        ":identity": identity,
        ":label": value.label,
        ":bucket": value.bucket,
        ":increment": value.count,
      },
    },
  }));
};

const stepMembers = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  maxItems: number,
): Promise<number> => {
  if (job.checkpoint.phase !== "members") {
    throw new DynamoDBInsightsV2InputError("Invalid member checkpoint");
  }
  const checkpoint = job.checkpoint;
  const tasks = memberTasks(job);
  const task = tasks[checkpoint.task];
  if (task === undefined) {
    throw new DynamoDBInsightsV2InputError("Invalid member task");
  }
  const result = await store.client.send(
    new QueryCommand({
      TableName: store.tableName,
      ConsistentRead: true,
      KeyConditionExpression:
        checkpoint.afterKey === null
          ? "#pk = :pk"
          : "#pk = :pk AND #sk > :after",
      ExpressionAttributeNames: {
        "#pk": "pk",
        ...(checkpoint.afterKey === null ? {} : { "#sk": "sk" }),
      },
      ExpressionAttributeValues: {
        ":pk": memberPk(job.id, task, checkpoint.shard.toString(16)),
        ...(checkpoint.afterKey === null
          ? {}
          : { ":after": checkpoint.afterKey }),
      },
      Limit: Math.min(maxItems, MAX_JOB_SOURCE_ITEMS),
      ScanIndexForward: true,
      ReturnConsumedCapacity: "TOTAL",
    }),
  );
  const members: ParsedMember[] = (result.Items ?? []).map(
    (item: Record<string, unknown>) => parseMember(item, job, task),
  );
  const minBucket = members.reduce(
    (minimum, value) =>
      value.bucketStartMs >= 0
        ? Math.min(minimum, value.bucketStartMs)
        : minimum,
    Number.POSITIVE_INFINITY,
  );
  const taskName = sectionKey(task.section, task.metric);
  const bounds =
    Number.isFinite(minBucket) &&
    (job.bounds[taskName] === undefined || minBucket < job.bounds[taskName])
      ? { ...job.bounds, [taskName]: minBucket }
      : job.bounds;
  const exhausted = result.LastEvaluatedKey === undefined;
  const lastKey = members.at(-1)?.sk ?? checkpoint.afterKey;
  const taskDone = exhausted && checkpoint.shard === 15;
  const allDone = taskDone && checkpoint.task + 1 === tasks.length;
  const next = jobWith(job, {
    bounds,
    checkpoint: allDone
      ? firstAfterMembers(job)
      : taskDone
        ? {
            phase: "members",
            task: checkpoint.task + 1,
            shard: 0,
            afterKey: null,
          }
        : exhausted
          ? {
              phase: "members",
              task: checkpoint.task,
              shard: checkpoint.shard + 1,
              afterKey: null,
            }
          : {
              phase: "members",
              task: checkpoint.task,
              shard: checkpoint.shard,
              afterKey: lastKey,
            },
  });
  await commitStep(
    store,
    job,
    next,
    await countActions(store, job, task, members),
  );
  return members.length;
};

type CountRow = {
  readonly pk: string;
  readonly sk: string;
  readonly label: string;
  readonly bucketStartMs: number;
  readonly value: number;
};

const parseCount = (
  item: Record<string, unknown>,
  job: Job,
  task: MemberTask,
): CountRow => {
  if (
    item.item_type !== "insights-job-count" ||
    item.job_id !== job.id ||
    item.section !== task.section ||
    item.metric !== task.metric ||
    typeof item.pk !== "string" ||
    typeof item.sk !== "string" ||
    typeof item.dimension_identity !== "string" ||
    typeof item.label !== "string" ||
    !Number.isSafeInteger(item.bucket_start_ms) ||
    !Number.isSafeInteger(item.value) ||
    Number(item.value) < 1
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights job count is invalid",
    );
  }
  const key = countKey(job.id, task, item.label, Number(item.bucket_start_ms));
  if (
    item.dimension_identity !==
      dimensionIdentity(item.label, Number(item.bucket_start_ms)) ||
    item.pk !== key.pk ||
    item.sk !== key.sk
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights job count checksum is invalid",
    );
  }
  return {
    pk: item.pk,
    sk: item.sk,
    label: item.label,
    bucketStartMs: Number(item.bucket_start_ms),
    value: Number(item.value),
  };
};

const readCounts = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  requests: readonly {
    readonly task: MemberTask;
    readonly label: string;
    readonly bucketStartMs: number;
  }[],
): Promise<readonly number[]> => {
  const keys = requests.map((request) =>
    countKey(job.id, request.task, request.label, request.bucketStartMs),
  );
  const items = await batchGetStrong(store, keys);
  const byKey = new Map(
    items.map((item) => [`${String(item.pk)}\n${String(item.sk)}`, item]),
  );
  return requests.map((request, index) => {
    const key = keys[index]!;
    const item = byKey.get(`${key.pk}\n${key.sk}`);
    return item === undefined ? 0 : parseCount(item, job, request.task).value;
  });
};

const pageRowPut = (
  store: DynamoDBInsightsV2Store,
  pk: string,
  ordinal: number,
  row: unknown,
): TransactItem => {
  const rowJson = canonicalInsightsJson(row);
  return {
    Put: {
      TableName: store.tableName,
      Item: {
        pk,
        sk: padded(ordinal),
        item_type: "insights-job-page-row",
        ordinal,
        row_bytes: textEncoder.encode(rowJson).byteLength,
        row,
      },
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "pk" },
    },
  };
};

const sectionMetaPut = (
  store: DynamoDBInsightsV2Store,
  job: Job,
  section: string,
  metric: string,
  runPartition: string,
  totalRows: number,
): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: {
      ...sectionMetaKey(job.id, section, metric),
      item_type: "insights-job-section",
      job_id: job.id,
      section,
      metric,
      run_pk: runPartition,
      total_rows: totalRows,
    },
    ConditionExpression:
      "attribute_not_exists(#pk) OR (#job = :job AND #section = :section AND #metric = :metric AND #run = :run AND #total = :total)",
    ExpressionAttributeNames: {
      "#pk": "pk",
      "#job": "job_id",
      "#section": "section",
      "#metric": "metric",
      "#run": "run_pk",
      "#total": "total_rows",
    },
    ExpressionAttributeValues: {
      ":job": job.id,
      ":section": section,
      ":metric": metric,
      ":run": runPartition,
      ":total": totalRows,
    },
  },
});

const afterFixed = (job: Job): JobCheckpoint =>
  sortTasks(job).length > 0
    ? { phase: "sort", task: 0, shard: 0, afterKey: null, runCount: 0 }
    : { phase: "finalize" };

const stepFixed = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  maxItems: number,
): Promise<number> => {
  if (job.checkpoint.phase !== "fixed" || job.job_kind !== "report") {
    throw new DynamoDBInsightsV2InputError("Invalid fixed-series checkpoint");
  }
  const checkpoint = job.checkpoint;
  const tasks = fixedTasks(job);
  const task = tasks[checkpoint.task];
  if (task === undefined) {
    throw new DynamoDBInsightsV2InputError("Invalid fixed-series task");
  }
  const projection = createInsightsReportProjection(
    job.query as InsightsReportQuery,
    job.as_of_ms,
  );
  const first =
    task.section === "activeSeries"
      ? projection.firstBucketMs!
      : (projection.firstBucketMs ??
        job.bounds[sectionKey(task.section, task.metric)] ??
        projection.lastBucketMs);
  const current = checkpoint.nextBucketMs ?? first;
  const remaining =
    Math.floor((projection.lastBucketMs - current) / projection.bucketSizeMs) +
    1;
  const count = Math.min(maxItems, 94, Math.max(remaining, 0));
  const buckets = Array.from(
    { length: count },
    (_, index) => current + index * projection.bucketSizeMs,
  );
  const values = await readCounts(
    store,
    job,
    buckets.map((bucketStartMs) => ({ task, label: "", bucketStartMs })),
  );
  const pk = pagePk(job.id, task.section, task.metric);
  const actions = buckets.map((bucketStartMs, index) =>
    pageRowPut(store, pk, checkpoint.nextOrdinal + index, {
      bucketStartMs,
      value: values[index]!,
    }),
  );
  const done = buckets.at(-1) === projection.lastBucketMs;
  if (done) {
    actions.push(
      sectionMetaPut(
        store,
        job,
        task.section,
        task.metric,
        pk,
        checkpoint.nextOrdinal + buckets.length,
      ),
    );
  }
  const allDone = done && checkpoint.task + 1 === tasks.length;
  const next = jobWith(job, {
    checkpoint: allDone
      ? afterFixed(job)
      : done
        ? {
            phase: "fixed",
            task: checkpoint.task + 1,
            nextBucketMs: null,
            nextOrdinal: 0,
          }
        : {
            phase: "fixed",
            task: checkpoint.task,
            nextBucketMs: current + buckets.length * projection.bucketSizeMs,
            nextOrdinal: checkpoint.nextOrdinal + buckets.length,
          },
  });
  await commitStep(store, job, next, actions);
  return buckets.length;
};

type SortRow = {
  readonly label: string;
  readonly value: number;
  readonly row: unknown;
};

const sortRow = (task: SortTask, count: CountRow): SortRow => ({
  label: count.label,
  value: count.value,
  row:
    task.publicSection === "movementCohorts"
      ? { cohort: count.label, value: count.value }
      : task.publicSection === "bundleDistribution"
        ? { bundleId: count.label, installations: count.value }
        : { bundleId: count.label, value: count.value },
});

const compareSortRows = (left: SortRow, right: SortRow): number =>
  right.value - left.value ||
  (left.label < right.label ? -1 : left.label > right.label ? 1 : 0);

const runRowPut = (
  store: DynamoDBInsightsV2Store,
  pk: string,
  ordinal: number,
  row: SortRow,
): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: {
      pk,
      sk: padded(ordinal),
      item_type: "insights-job-run-row",
      ordinal,
      label: row.label,
      value: row.value,
      row: row.row,
    },
    ConditionExpression: "attribute_not_exists(#pk)",
    ExpressionAttributeNames: { "#pk": "pk" },
  },
});

const runMetaPut = (
  store: DynamoDBInsightsV2Store,
  job: Job,
  task: number,
  level: number,
  run: number,
  total: number,
): TransactItem => ({
  Put: {
    TableName: store.tableName,
    Item: {
      ...runMetaKey(job.id, task, level, run),
      item_type: "insights-job-run-meta",
      job_id: job.id,
      task,
      level,
      run,
      run_pk: runPk(job.id, task, level, run),
      total_rows: total,
    },
    ConditionExpression: "attribute_not_exists(#pk)",
    ExpressionAttributeNames: { "#pk": "pk" },
  },
});

const nextSortTask = (
  store: DynamoDBInsightsV2Store,
  job: Job,
  task: number,
  finalRunPk: string,
  total: number,
): {
  readonly checkpoint: JobCheckpoint;
  readonly meta?: TransactItem;
} => {
  const tasks = sortTasks(job);
  const current = tasks[task]!;
  const last = task + 1 === tasks.length;
  const checkpoint: JobCheckpoint =
    current.publicSection === "activeBundleSeries"
      ? {
          phase: "expand",
          runPk: finalRunPk,
          bundlePosition: 0,
          nextOrdinal: 0,
        }
      : last
        ? { phase: "finalize" }
        : {
            phase: "sort",
            task: task + 1,
            shard: 0,
            afterKey: null,
            runCount: 0,
          };
  return {
    checkpoint,
    ...(current.publicSection === "activeBundleSeries"
      ? {}
      : {
          meta: sectionMetaPut(
            store,
            job,
            current.publicSection,
            current.metric,
            finalRunPk,
            total,
          ),
        }),
  };
};

const stepSort = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  maxItems: number,
): Promise<number> => {
  if (job.checkpoint.phase !== "sort") {
    throw new DynamoDBInsightsV2InputError("Invalid sort checkpoint");
  }
  const checkpoint = job.checkpoint;
  const tasks = sortTasks(job);
  const task = tasks[checkpoint.task];
  if (task === undefined) {
    throw new DynamoDBInsightsV2InputError("Invalid sort task");
  }
  const result = await store.client.send(
    new QueryCommand({
      TableName: store.tableName,
      ConsistentRead: true,
      KeyConditionExpression:
        checkpoint.afterKey === null
          ? "#pk = :pk"
          : "#pk = :pk AND #sk > :after",
      ExpressionAttributeNames: {
        "#pk": "pk",
        ...(checkpoint.afterKey === null ? {} : { "#sk": "sk" }),
      },
      ExpressionAttributeValues: {
        ":pk": countPartition(job.id, task, checkpoint.shard),
        ...(checkpoint.afterKey === null
          ? {}
          : { ":after": checkpoint.afterKey }),
      },
      Limit: Math.min(maxItems, 94),
      ScanIndexForward: true,
      ReturnConsumedCapacity: "TOTAL",
    }),
  );
  const counts: CountRow[] = (result.Items ?? []).map(
    (item: Record<string, unknown>) => parseCount(item, job, task),
  );
  const rows = counts
    .map((count) => sortRow(task, count))
    .sort(compareSortRows);
  const pk = runPk(job.id, checkpoint.task, 0, checkpoint.runCount);
  const actions = rows.map((row, index) => runRowPut(store, pk, index, row));
  if (rows.length > 0) {
    actions.push(
      runMetaPut(
        store,
        job,
        checkpoint.task,
        0,
        checkpoint.runCount,
        rows.length,
      ),
    );
  }
  const exhausted = result.LastEvaluatedKey === undefined;
  const lastKey = counts.at(-1)?.sk ?? checkpoint.afterKey;
  const taskInputDone = exhausted && checkpoint.shard === 15;
  const runCount = checkpoint.runCount + (rows.length > 0 ? 1 : 0);
  if (taskInputDone && runCount === 0) {
    const emptyPk = pagePk(job.id, task.publicSection, task.metric);
    const nextTask = nextSortTask(store, job, checkpoint.task, emptyPk, 0);
    if (nextTask.meta !== undefined) actions.push(nextTask.meta);
    const next = jobWith(job, { checkpoint: nextTask.checkpoint });
    await commitStep(store, job, next, actions);
    return 0;
  }
  const next = jobWith(job, {
    checkpoint: taskInputDone
      ? {
          phase: "merge",
          task: checkpoint.task,
          level: 0,
          inputRuns: runCount,
          pair: 0,
          leftPosition: 0,
          rightPosition: 0,
          outputPosition: 0,
        }
      : exhausted
        ? {
            phase: "sort",
            task: checkpoint.task,
            shard: checkpoint.shard + 1,
            afterKey: null,
            runCount,
          }
        : {
            phase: "sort",
            task: checkpoint.task,
            shard: checkpoint.shard,
            afterKey: lastKey,
            runCount,
          },
  });
  await commitStep(store, job, next, actions);
  return rows.length;
};

const parseRunMeta = (
  value: Record<string, unknown> | undefined,
  job: Job,
  task: number,
  level: number,
  run: number,
): { readonly runPk: string; readonly total: number } | null => {
  if (value === undefined) return null;
  if (
    value.item_type !== "insights-job-run-meta" ||
    value.job_id !== job.id ||
    value.task !== task ||
    value.level !== level ||
    value.run !== run ||
    typeof value.run_pk !== "string" ||
    !Number.isSafeInteger(value.total_rows) ||
    Number(value.total_rows) < 0
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights run metadata is invalid",
    );
  }
  return { runPk: value.run_pk, total: Number(value.total_rows) };
};

const parseRunRow = (value: Record<string, unknown>): SortRow => {
  if (
    value.item_type !== "insights-job-run-row" ||
    !Number.isSafeInteger(value.ordinal) ||
    typeof value.label !== "string" ||
    !Number.isSafeInteger(value.value) ||
    Number(value.value) < 1 ||
    typeof value.row !== "object" ||
    value.row === null
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights run row is invalid",
    );
  }
  return {
    label: value.label,
    value: Number(value.value),
    row: value.row,
  };
};

const readRunRows = async (
  store: DynamoDBInsightsV2Store,
  meta: { readonly runPk: string; readonly total: number } | null,
  position: number,
  limit: number,
): Promise<readonly SortRow[]> => {
  if (meta === null || position >= meta.total) return [];
  const result = await store.client.send(
    new QueryCommand({
      TableName: store.tableName,
      ConsistentRead: true,
      KeyConditionExpression: "#pk = :pk AND #sk >= :position",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": meta.runPk,
        ":position": padded(position),
      },
      Limit: limit,
      ScanIndexForward: true,
      ReturnConsumedCapacity: "TOTAL",
    }),
  );
  return (result.Items ?? []).map(parseRunRow);
};

const stepMerge = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  maxItems: number,
): Promise<number> => {
  if (job.checkpoint.phase !== "merge") {
    throw new DynamoDBInsightsV2InputError("Invalid merge checkpoint");
  }
  const checkpoint = job.checkpoint;
  const leftRun = checkpoint.pair * 2;
  const rightRun = leftRun + 1;
  const metaItems = await batchGetStrong(store, [
    runMetaKey(job.id, checkpoint.task, checkpoint.level, leftRun),
    ...(rightRun < checkpoint.inputRuns
      ? [runMetaKey(job.id, checkpoint.task, checkpoint.level, rightRun)]
      : []),
  ]);
  const byKey = new Map(
    metaItems.map((item) => [`${String(item.pk)}\n${String(item.sk)}`, item]),
  );
  const meta = (run: number) => {
    const key = runMetaKey(job.id, checkpoint.task, checkpoint.level, run);
    return parseRunMeta(
      byKey.get(`${key.pk}\n${key.sk}`),
      job,
      checkpoint.task,
      checkpoint.level,
      run,
    );
  };
  const left = meta(leftRun);
  const right = rightRun < checkpoint.inputRuns ? meta(rightRun) : null;
  if (left === null || (rightRun < checkpoint.inputRuns && right === null)) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights merge input is missing",
    );
  }
  const limit = Math.min(maxItems, 94);
  const [leftRows, rightRows] = await Promise.all([
    readRunRows(store, left, checkpoint.leftPosition, limit),
    readRunRows(store, right, checkpoint.rightPosition, limit),
  ]);
  const output: SortRow[] = [];
  let leftUsed = 0;
  let rightUsed = 0;
  while (output.length < limit) {
    const leftValue = leftRows[leftUsed];
    const rightValue = rightRows[rightUsed];
    if (leftValue === undefined && rightValue === undefined) break;
    if (
      rightValue === undefined ||
      (leftValue !== undefined && compareSortRows(leftValue, rightValue) <= 0)
    ) {
      output.push(leftValue!);
      leftUsed += 1;
    } else {
      output.push(rightValue);
      rightUsed += 1;
    }
  }
  const leftPosition = checkpoint.leftPosition + leftUsed;
  const rightPosition = checkpoint.rightPosition + rightUsed;
  const outputPosition = checkpoint.outputPosition + output.length;
  const pairDone =
    leftPosition === left.total && rightPosition === (right?.total ?? 0);
  const outputRun = checkpoint.pair;
  const outputPk = runPk(
    job.id,
    checkpoint.task,
    checkpoint.level + 1,
    outputRun,
  );
  const actions = output.map((row, index) =>
    runRowPut(store, outputPk, checkpoint.outputPosition + index, row),
  );
  if (pairDone) {
    actions.push(
      runMetaPut(
        store,
        job,
        checkpoint.task,
        checkpoint.level + 1,
        outputRun,
        outputPosition,
      ),
    );
  }
  const outputRuns = Math.ceil(checkpoint.inputRuns / 2);
  const levelDone = pairDone && checkpoint.pair + 1 === outputRuns;
  let nextCheckpoint: JobCheckpoint;
  if (levelDone && outputRuns === 1) {
    const nextTask = nextSortTask(
      store,
      job,
      checkpoint.task,
      outputPk,
      outputPosition,
    );
    if (nextTask.meta !== undefined) actions.push(nextTask.meta);
    nextCheckpoint = nextTask.checkpoint;
  } else if (levelDone) {
    nextCheckpoint = {
      phase: "merge",
      task: checkpoint.task,
      level: checkpoint.level + 1,
      inputRuns: outputRuns,
      pair: 0,
      leftPosition: 0,
      rightPosition: 0,
      outputPosition: 0,
    };
  } else if (pairDone) {
    nextCheckpoint = {
      phase: "merge",
      task: checkpoint.task,
      level: checkpoint.level,
      inputRuns: checkpoint.inputRuns,
      pair: checkpoint.pair + 1,
      leftPosition: 0,
      rightPosition: 0,
      outputPosition: 0,
    };
  } else {
    nextCheckpoint = {
      ...checkpoint,
      leftPosition,
      rightPosition,
      outputPosition,
    };
  }
  const next = jobWith(job, { checkpoint: nextCheckpoint });
  await commitStep(store, job, next, actions);
  return output.length;
};

const stepExpand = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
  maxItems: number,
): Promise<number> => {
  if (
    job.checkpoint.phase !== "expand" ||
    job.job_kind !== "report" ||
    job.query.kind !== "activeOverview"
  ) {
    throw new DynamoDBInsightsV2InputError("Invalid expansion checkpoint");
  }
  const checkpoint = job.checkpoint;
  const projection = createInsightsReportProjection(job.query, job.as_of_ms);
  const bucketCount =
    Math.floor(
      (projection.lastBucketMs - projection.firstBucketMs!) /
        projection.bucketSizeMs,
    ) + 1;
  const bundleLimit = Math.max(
    1,
    Math.min(3, Math.floor(Math.min(maxItems, 94) / (bucketCount + 1))),
  );
  const result = await store.client.send(
    new QueryCommand({
      TableName: store.tableName,
      ConsistentRead: true,
      KeyConditionExpression: "#pk = :pk AND #sk >= :position",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": checkpoint.runPk,
        ":position": padded(checkpoint.bundlePosition),
      },
      Limit: bundleLimit,
      ScanIndexForward: true,
      ReturnConsumedCapacity: "TOTAL",
    }),
  );
  const bundles: SortRow[] = (result.Items ?? []).map(parseRunRow);
  const requests = bundles.flatMap((bundle) =>
    Array.from({ length: bucketCount }, (_, index) => ({
      task: { section: "activeBundleSeries", metric: "" },
      label: bundle.label,
      bucketStartMs:
        projection.firstBucketMs! + index * projection.bucketSizeMs,
    })),
  );
  const counts = await readCounts(store, job, requests);
  const outputPk = pagePk(job.id, "activeBundleSeries");
  const actions: TransactItem[] = [];
  const requestedFilters = new Map<
    string,
    { readonly bundleId: string; readonly key: { pk: string; sk: string } }
  >();
  for (const bundle of bundles) {
    const filter = filterKey(job.id, bundle.label);
    const identity = `${filter.pk}\n${filter.sk}`;
    const previous = requestedFilters.get(identity);
    if (previous !== undefined && previous.bundleId !== bundle.label) {
      throw new DynamoDBInsightsV2HashCollisionError(bundle.label);
    }
    requestedFilters.set(identity, { bundleId: bundle.label, key: filter });
  }
  const existingFilters = await batchGetStrong(
    store,
    [...requestedFilters.values()].map((value) => value.key),
  );
  const filtersByKey = new Map(
    existingFilters.map((item) => [
      `${String(item.pk)}\n${String(item.sk)}`,
      item,
    ]),
  );
  let ordinal = checkpoint.nextOrdinal;
  for (let bundle = 0; bundle < bundles.length; bundle++) {
    const start = ordinal;
    for (let bucket = 0; bucket < bucketCount; bucket++) {
      const request = requests[bundle * bucketCount + bucket]!;
      actions.push(
        pageRowPut(store, outputPk, ordinal, {
          bundleId: bundles[bundle]!.label,
          bucketStartMs: request.bucketStartMs,
          value: counts[bundle * bucketCount + bucket]!,
        }),
      );
      ordinal += 1;
    }
    const filter = filterKey(job.id, bundles[bundle]!.label);
    const existing = filtersByKey.get(`${filter.pk}\n${filter.sk}`);
    if (
      existing !== undefined &&
      (existing.item_type !== "insights-job-section-filter" ||
        existing.job_id !== job.id ||
        existing.bundle_id !== bundles[bundle]!.label ||
        existing.start_ordinal !== start ||
        existing.total_rows !== bucketCount)
    ) {
      throw new DynamoDBInsightsV2HashCollisionError(bundles[bundle]!.label);
    }
    actions.push({
      Put: {
        TableName: store.tableName,
        Item: {
          ...filter,
          item_type: "insights-job-section-filter",
          job_id: job.id,
          bundle_id: bundles[bundle]!.label,
          start_ordinal: start,
          total_rows: bucketCount,
        },
        ConditionExpression:
          "attribute_not_exists(#pk) OR (#job = :job AND #bundle = :bundle AND #start = :start AND #total = :total)",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#job": "job_id",
          "#bundle": "bundle_id",
          "#start": "start_ordinal",
          "#total": "total_rows",
        },
        ExpressionAttributeValues: {
          ":job": job.id,
          ":bundle": bundles[bundle]!.label,
          ":start": start,
          ":total": bucketCount,
        },
      },
    });
  }
  const exhausted = result.LastEvaluatedKey === undefined;
  if (exhausted) {
    actions.push(
      sectionMetaPut(store, job, "activeBundleSeries", "", outputPk, ordinal),
    );
  }
  const next = jobWith(job, {
    checkpoint: exhausted
      ? { phase: "finalize" }
      : {
          phase: "expand",
          runPk: checkpoint.runPk,
          bundlePosition: checkpoint.bundlePosition + bundles.length,
          nextOrdinal: ordinal,
        },
  });
  await commitStep(store, job, next, actions);
  return bundles.length * bucketCount;
};

const finalValues = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
): Promise<{ readonly total?: number; readonly summary?: unknown }> => {
  if (job.job_kind === "search") {
    const [total] = await readCounts(store, job, [
      {
        task: { section: "search", metric: "" },
        label: "",
        bucketStartMs: -1,
      },
    ]);
    return { total };
  }
  switch (job.query.kind) {
    case "bundleSummaries": {
      const requests = job.query.bundleIds.flatMap((bundleId) => [
        {
          task: { section: "summary", metric: "installed" },
          label: bundleId,
          bucketStartMs: -1,
        },
        {
          task: { section: "summary", metric: "recovered" },
          label: bundleId,
          bucketStartMs: -1,
        },
      ]);
      const counts = await readCounts(store, job, requests);
      return {
        summary: job.query.bundleIds.map((bundleId, index) => ({
          bundleId,
          installed: counts[index * 2]!,
          recovered: counts[index * 2 + 1]!,
        })),
      };
    }
    case "bundleDetail": {
      const [installed, recovered] = await readCounts(store, job, [
        {
          task: { section: "summary", metric: "installed" },
          label: job.query.bundleId,
          bucketStartMs: -1,
        },
        {
          task: { section: "summary", metric: "recovered" },
          label: job.query.bundleId,
          bucketStartMs: -1,
        },
      ]);
      return { summary: { installed, recovered } };
    }
    case "installationOverview":
    case "activeOverview": {
      const [total] = await readCounts(store, job, [
        {
          task: { section: "installations", metric: "" },
          label: "",
          bucketStartMs: -1,
        },
      ]);
      return {
        summary:
          job.query.kind === "installationOverview"
            ? { trackedInstallations: total }
            : { activeInstallations: total },
      };
    }
    default:
      throw new DynamoDBInsightsV2InputError("Invalid final job query");
  }
};

const stepFinalize = async (
  store: DynamoDBInsightsV2Store,
  job: Job,
): Promise<number> => {
  if (job.checkpoint.phase !== "finalize") {
    throw new DynamoDBInsightsV2InputError("Invalid finalize checkpoint");
  }
  const values = await finalValues(store, job);
  const head = parseHead(await getStrong(store, headKey(job.query_key)));
  if (
    head === null ||
    head.query_key !== job.query_key ||
    head.active_job_id !== job.id
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights active job head is invalid",
    );
  }
  const completedAtMs = Math.max(Date.now(), job.as_of_ms);
  const next = jobWith(job, {
    status: "ready",
    completed_at_ms: completedAtMs,
    ...values,
  });
  const nextHead: Head = {
    ...head,
    revision: nextSafeRevision(head.revision),
    active_job_id: null,
    publication_id: job.id,
  };
  try {
    await sendTransaction(store, `finalize:${job.id}:${job.revision}`, [
      jobPut(store, next, job.revision),
      headPut(store, nextHead, head.revision),
    ]);
  } catch (error) {
    const current = await readJob(store, job.id);
    if (current !== null && current.revision > job.revision) return 0;
    if (conditionalCancellationIndexes(error).length > 0) {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "DynamoDB Insights publication collided with persisted storage",
      );
    }
    throw error;
  }
  return 0;
};

export interface RunDynamoDBInsightsJobInput {
  readonly jobId: string;
  readonly maxItems: number;
  readonly maxRequests: number;
}

export interface DynamoDBInsightsJobStep {
  readonly jobId: string;
  readonly state: JobStatus;
  readonly phase: JobCheckpoint["phase"];
  readonly revision: number;
  readonly processed: number;
}

const jobStepResult = (
  job: Job,
  processed: number,
): DynamoDBInsightsJobStep => ({
  jobId: job.id,
  state: job.status,
  phase: job.checkpoint.phase,
  revision: job.revision,
  processed,
});

export const runDynamoDBInsightsJobStep = async (
  store: DynamoDBInsightsV2Store,
  input: RunDynamoDBInsightsJobInput,
): Promise<DynamoDBInsightsJobStep> => {
  assertInsightsMaintenanceInputContract(input);
  if (!isCanonicalInsightsEventId(input.jobId) || input.maxRequests < 1) {
    throw new DynamoDBInsightsV2InputError(
      "Invalid DynamoDB Insights job runner input",
    );
  }
  const bounded = requestBudgetStore(store, input.maxRequests);
  let job = await readJob(bounded, input.jobId);
  if (job === null) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights job does not exist",
    );
  }
  if (input.maxRequests < 8) return jobStepResult(job, 0);
  if (job.status !== "preparing") return jobStepResult(job, 0);
  const maxItems = Math.min(input.maxItems, MAX_JOB_STEP_ITEMS);
  let processed = 0;
  for (let phaseSteps = 0; phaseSteps < 128; phaseSteps++) {
    if (
      job.status !== "preparing" ||
      processed >= maxItems ||
      bounded.requestsUsed() + 8 > input.maxRequests
    ) {
      break;
    }
    let stepItems = 0;
    try {
      switch (job.checkpoint.phase) {
        case "source":
          stepItems = await stepSource(bounded, job, maxItems - processed);
          break;
        case "installations":
          stepItems = await stepInstallations(
            bounded,
            job,
            maxItems - processed,
          );
          break;
        case "members":
          stepItems = await stepMembers(bounded, job, maxItems - processed);
          break;
        case "fixed":
          stepItems = await stepFixed(bounded, job, maxItems - processed);
          break;
        case "sort":
          stepItems = await stepSort(bounded, job, maxItems - processed);
          break;
        case "merge":
          stepItems = await stepMerge(bounded, job, maxItems - processed);
          break;
        case "expand":
          stepItems = await stepExpand(bounded, job, maxItems - processed);
          break;
        case "finalize":
          stepItems = await stepFinalize(bounded, job);
          break;
      }
    } catch (error) {
      if (
        error instanceof DynamoDBInsightsV2BudgetError ||
        isRetryableDynamoDBInsightsError(error)
      ) {
        throw error;
      }
      await failJob(bounded, job, error);
    }
    processed += stepItems;
    job = await readJob(bounded, input.jobId);
    if (job === null) {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "DynamoDB Insights job disappeared",
      );
    }
  }
  return jobStepResult(job, processed);
};

const expiredResult = (publicationId: string) => {
  const result = { state: "expired" as const, publicationId };
  assertInsightsExpiredReadContract(result);
  return result;
};

const snapshotPublication = (job: Job) => ({
  id: job.id,
  asOfMs: job.as_of_ms,
  completedAtMs: job.completed_at_ms!,
  sourceGeneration: job.source_generation,
  accuracy: "exact" as const,
});

type ParsedSearchInput = {
  readonly query: SearchQuery;
  readonly key: string;
  readonly publicationId?: string;
  readonly shard: number;
  readonly afterKey: string | null;
};

const parseSearchInput = (
  store: DynamoDBInsightsV2Store,
  input: InsightsPublishedInstallationPageInput,
): ParsedSearchInput => {
  const query = normalizeSearch(input);
  if (
    input.publicationId !== undefined &&
    !isCanonicalInsightsEventId(input.publicationId)
  ) {
    throw new DynamoDBInsightsV2InputError(
      "Invalid published installation query",
    );
  }
  const key = queryKey("search", query);
  let publicationId = input.publicationId;
  let shard = 0;
  let afterKey: string | null = null;
  if (input.cursor !== undefined) {
    let cursor: unknown;
    try {
      cursor = JSON.parse(input.cursor);
    } catch {
      throw new DynamoDBInsightsV2InputError(
        "Invalid published installation cursor",
      );
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 6 ||
      cursor[0] !== JOB_CURSOR_VERSION ||
      cursor[1] !== dynamoDBInsightsV2Namespace(store) ||
      cursor[2] !== key ||
      !isCanonicalInsightsEventId(cursor[3]) ||
      !Number.isSafeInteger(cursor[4]) ||
      Number(cursor[4]) < 0 ||
      Number(cursor[4]) > 15 ||
      (cursor[5] !== null &&
        (typeof cursor[5] !== "string" || cursor[5].length > 256)) ||
      (publicationId !== undefined && publicationId !== cursor[3])
    ) {
      throw new DynamoDBInsightsV2InputError(
        "Invalid published installation cursor",
      );
    }
    publicationId = cursor[3];
    shard = Number(cursor[4]);
    afterKey = cursor[5];
  }
  return { query, key, publicationId, shard, afterKey };
};

const searchCursor = (
  store: DynamoDBInsightsV2Store,
  parsed: ParsedSearchInput,
  publicationId: string,
  shard: number,
  afterKey: string | null,
): string => {
  const cursor = canonicalInsightsJson([
    JOB_CURSOR_VERSION,
    dynamoDBInsightsV2Namespace(store),
    parsed.key,
    publicationId,
    shard,
    afterKey,
  ]);
  assertInsightsCursorContract(cursor);
  return cursor;
};

const sameJobQuery = (
  job: Job,
  kind: JobKind,
  key: string,
  query?: JobQuery,
): boolean =>
  job.job_kind === kind &&
  job.query_key === key &&
  (query === undefined || sameStoredQuery(job.query, query));

const readSearchPage = async (
  store: DynamoDBInsightsV2Store,
  input: InsightsPublishedInstallationPageInput,
  parsed: ParsedSearchInput,
  job: Job,
  state: "ready" | "stale",
  refreshJobId?: string,
): Promise<InsightsPublishedInstallationPage> => {
  if (
    job.status !== "ready" ||
    job.total === undefined ||
    job.completed_at_ms === undefined
  ) {
    throw new DynamoDBInsightsV2InputError(
      "DynamoDB Insights search publication is invalid",
    );
  }
  const task = { section: "search", metric: "" } as const;
  let pageShard = parsed.shard;
  let afterKey = parsed.afterKey;
  const members: Array<{
    readonly member: ParsedMember;
    readonly shard: number;
  }> = [];
  while (pageShard < 16 && members.length < input.limit + 1) {
    const result = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        ConsistentRead: true,
        KeyConditionExpression:
          afterKey === null ? "#pk = :pk" : "#pk = :pk AND #sk > :after",
        ExpressionAttributeNames: {
          "#pk": "pk",
          ...(afterKey === null ? {} : { "#sk": "sk" }),
        },
        ExpressionAttributeValues: {
          ":pk": memberPk(job.id, task, pageShard.toString(16)),
          ...(afterKey === null ? {} : { ":after": afterKey }),
        },
        Limit: input.limit + 1 - members.length,
        ScanIndexForward: true,
        ReturnConsumedCapacity: "TOTAL",
      }),
    );
    const page: Record<string, unknown>[] = result.Items ?? [];
    members.push(
      ...page.map((item) => ({
        member: parseMember(item, job, task),
        shard: pageShard,
      })),
    );
    const last = page.at(-1)?.sk;
    if (last !== undefined && typeof last !== "string") {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "DynamoDB Insights search member key is invalid",
      );
    }
    if (result.LastEvaluatedKey !== undefined && last !== undefined) {
      afterKey = last;
    } else {
      pageShard += 1;
      afterKey = null;
    }
  }
  const latest = await batchGetStrong(
    store,
    members.map(({ member }) => latestKey(job.id, member.installHash, -1)),
  );
  const byHash = new Map(
    latest.map((item) => {
      const row = parseLatest(item, job);
      if (row.bucketIndex !== -1) {
        throw new DynamoDBInsightsV2InputError(
          "DynamoDB Insights search latest bucket is invalid",
        );
      }
      return [row.installHash, row] as const;
    }),
  );
  const rows = members.map(({ member, shard }) => {
    const current = byHash.get(member.installHash);
    if (current === undefined || current.installId !== member.installId) {
      throw new DynamoDBInsightsV2InputError(
        "DynamoDB Insights search latest row is missing",
      );
    }
    return { member, shard, row: installationRow(current.row) };
  });
  let selected = rows.slice(0, input.limit);
  for (;;) {
    const last = selected.at(-1);
    const hasMore = members.length > selected.length;
    const nextCursor =
      hasMore && last !== undefined
        ? searchCursor(store, parsed, job.id, last.shard, last.member.sk)
        : null;
    if (hasMore && nextCursor === null) {
      throw new DynamoDBInsightsV2InputError(
        "DynamoDB Insights search page did not advance",
      );
    }
    const data = {
      data: selected.map(({ row }) => row),
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "snapshot" as const,
        cutoff: {
          kind: "publication" as const,
          publication: searchPublication(job),
        },
      },
      total: {
        state: "exact" as const,
        value: job.total,
        sourceGeneration: job.source_generation,
      },
    };
    const page: InsightsPublishedInstallationPage =
      state === "ready"
        ? {
            state,
            versions: versions(job.source_generation, job.id),
            data,
          }
        : {
            state,
            versions: versions(job.source_generation, job.id),
            data,
            refresh: { id: refreshJobId! },
          };
    if (getCanonicalInsightsJsonByteLength(page) <= INSIGHTS_PAGE_MAX_BYTES) {
      assertInsightsPageContract(page, input.limit);
      return page;
    }
    if (selected.length <= 1) {
      throw new DynamoDBInsightsV2InputError(
        `DynamoDB Insights search row exceeds ${DYNAMODB_INSIGHTS_PAGE_MAX_BYTES} bytes`,
      );
    }
    selected = selected.slice(0, -1);
  }
};

const pagePublishedInstallations = async (
  store: DynamoDBInsightsV2Store,
  input: InsightsPublishedInstallationPageInput,
): Promise<InsightsPublishedInstallationPage> => {
  const parsed = parseSearchInput(store, input);
  let publication: Job | undefined;
  try {
    if (parsed.publicationId !== undefined) {
      const pinned = await readJob(store, parsed.publicationId);
      if (
        pinned === null ||
        !sameJobQuery(pinned, "search", parsed.key, parsed.query)
      ) {
        return expiredResult(parsed.publicationId);
      }
      publication = pinned;
      if (pinned.status === "failed") return failedResult(pinned);
      if (
        pinned.status !== "ready" ||
        pinned.as_of_ms < (input.minAsOfMs ?? 0)
      ) {
        return expiredResult(parsed.publicationId);
      }
      return readSearchPage(store, input, parsed, pinned, "ready");
    }
    const migration = await migrationState(store);
    if (migration !== null) return migration;
    const reserved = await reserveJob(
      store,
      "search",
      parsed.query,
      input.minAsOfMs ?? 0,
    );
    if (reserved.state === "ready") {
      publication = reserved.job;
      return readSearchPage(store, input, parsed, reserved.job, "ready");
    }
    if (reserved.state === "failed") return failedResult(reserved.job);
    if (reserved.previous === null) return preparingResult(reserved.job);
    if (
      reserved.previous.status !== "ready" ||
      !sameJobQuery(reserved.previous, "search", parsed.key, parsed.query)
    ) {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "DynamoDB Insights previous search publication is invalid",
      );
    }
    publication = reserved.previous;
    return readSearchPage(
      store,
      input,
      parsed,
      reserved.previous,
      "stale",
      reserved.job.id,
    );
  } catch (error) {
    if (isPublicationCorruption(error)) {
      return storageCorruptionResult(publication);
    }
    throw error;
  }
};

const readyReportResult = (job: Job): InsightsReportResult => {
  const result: InsightsReportResult = {
    state: "ready",
    versions: versions(job.source_generation, job.id),
    data: publication(job),
  };
  assertInsightsReportResultContract(result);
  return result;
};

export const getDynamoDBInsightsReport = async (
  store: DynamoDBInsightsV2Store,
  input: InsightsReportInput,
): Promise<InsightsReportResult> => {
  const canonical = readInsightsReportQuery(input);
  const query = canonical.query;
  let publicationJob: Job | undefined;
  try {
    const migration = await migrationState(store);
    if (migration !== null) {
      assertInsightsReportResultContract(migration);
      return migration;
    }
    const reserved = await reserveJob(
      store,
      "report",
      query,
      canonical.minAsOfMs ?? 0,
    );
    if (reserved.state === "ready") {
      publicationJob = reserved.job;
      return readyReportResult(reserved.job);
    }
    if (reserved.state === "failed") {
      const result = failedResult(reserved.job);
      assertInsightsReportResultContract(result);
      return result;
    }
    if (reserved.previous === null) {
      const result = preparingResult(reserved.job);
      assertInsightsReportResultContract(result);
      return result;
    }
    if (
      reserved.previous.status !== "ready" ||
      !sameJobQuery(reserved.previous, "report", reserved.job.query_key, query)
    ) {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "DynamoDB Insights previous report publication is invalid",
      );
    }
    publicationJob = reserved.previous;
    const result: InsightsReportResult = {
      state: "stale",
      versions: versions(
        reserved.previous.source_generation,
        reserved.previous.id,
      ),
      data: publication(reserved.previous),
      refresh: { id: reserved.job.id },
    };
    assertInsightsReportResultContract(result);
    return result;
  } catch (error) {
    if (isPublicationCorruption(error)) {
      const result = storageCorruptionResult(publicationJob);
      assertInsightsReportResultContract(result);
      return result;
    }
    throw error;
  }
};

type SectionMeta = {
  readonly runPk: string;
  readonly total: number;
};

const parseSectionMeta = (
  value: Record<string, unknown> | undefined,
  job: Job,
  section: string,
  metric: string,
): SectionMeta => {
  if (
    value === undefined ||
    value.item_type !== "insights-job-section" ||
    value.job_id !== job.id ||
    value.section !== section ||
    value.metric !== metric ||
    typeof value.run_pk !== "string" ||
    !Number.isSafeInteger(value.total_rows) ||
    Number(value.total_rows) < 0
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights report section is invalid",
    );
  }
  return { runPk: value.run_pk, total: Number(value.total_rows) };
};

const parseFilter = (
  value: Record<string, unknown> | undefined,
  job: Job,
  bundleId: string,
): { readonly start: number; readonly total: number } | null => {
  if (value === undefined) return null;
  if (
    value.item_type !== "insights-job-section-filter" ||
    value.job_id !== job.id ||
    value.bundle_id !== bundleId ||
    !Number.isSafeInteger(value.start_ordinal) ||
    Number(value.start_ordinal) < 0 ||
    !Number.isSafeInteger(value.total_rows) ||
    Number(value.total_rows) < 0
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      `DynamoDB Insights report filter is invalid for ${JSON.stringify(bundleId)}`,
    );
  }
  return {
    start: Number(value.start_ordinal),
    total: Number(value.total_rows),
  };
};

const validReportSection = (
  job: Job,
  section: ReturnType<typeof readInsightsReportPageQuery>["input"],
): boolean =>
  job.job_kind === "report" &&
  ((job.query.kind === "bundleDetail" &&
    (section.section === "movementSeries" ||
      section.section === "movementCohorts")) ||
    ((job.query.kind === "installationOverview" ||
      job.query.kind === "activeOverview") &&
      section.section === "bundleDistribution") ||
    (job.query.kind === "activeOverview" &&
      (section.section === "activeSeries" ||
        section.section === "activeBundleSeries")));

const readDynamoDBReportPageQuery = (
  store: DynamoDBInsightsV2Store,
  input: InsightsReportPageInput,
): ReturnType<typeof readInsightsReportPageQuery> => {
  return readInsightsReportPageQuery(input, dynamoDBInsightsV2Namespace(store));
};

const storedPageRow = (
  value: Record<string, unknown>,
  expectedPk: string,
  expectedOrdinal: number,
): unknown => {
  if (
    value.pk !== expectedPk ||
    value.sk !== padded(expectedOrdinal) ||
    value.ordinal !== expectedOrdinal
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights report row order is invalid",
    );
  }
  if (value.item_type === "insights-job-run-row") {
    return parseRunRow(value).row;
  }
  if (
    value.item_type !== "insights-job-page-row" ||
    !Number.isSafeInteger(value.row_bytes) ||
    Number(value.row_bytes) < 0 ||
    value.row === undefined ||
    getCanonicalInsightsJsonByteLength(value.row) !== value.row_bytes
  ) {
    throw new DynamoDBInsightsV2StorageCorruptionError(
      "DynamoDB Insights report row is invalid",
    );
  }
  return value.row;
};

export const pageDynamoDBInsightsReport = async (
  store: DynamoDBInsightsV2Store,
  input: InsightsReportPageInput,
): Promise<InsightsReportPage> => {
  const parsed = readDynamoDBReportPageQuery(store, input);
  const publicationId = parsed.input.publicationId;
  if (!isCanonicalInsightsEventId(publicationId)) {
    throw new DynamoDBInsightsV2InputError(
      "Invalid DynamoDB Insights report publication",
    );
  }
  let job: Job | null;
  try {
    job = await readJob(store, publicationId);
  } catch (error) {
    if (isPublicationCorruption(error)) {
      const result = storageCorruptionResult();
      assertInsightsReportPageResultContract(result, input.limit);
      return result;
    }
    throw error;
  }
  if (job === null || job.job_kind !== "report") {
    const result = expiredResult(publicationId);
    assertInsightsReportPageResultContract(result, input.limit);
    return result;
  }
  if (job.status === "failed") {
    const result = failedResult(job);
    assertInsightsReportPageResultContract(result, input.limit);
    return result;
  }
  if (job.status !== "ready") {
    const result = expiredResult(publicationId);
    assertInsightsReportPageResultContract(result, input.limit);
    return result;
  }
  if (!validReportSection(job, parsed.input)) {
    throw new DynamoDBInsightsV2InputError(
      "Report section is not available for this publication",
    );
  }
  try {
    const metric = "metric" in parsed.input ? parsed.input.metric : "";
    const meta = parseSectionMeta(
      await getStrong(
        store,
        sectionMetaKey(job.id, parsed.input.section, metric),
      ),
      job,
      parsed.input.section,
      metric,
    );
    let startOffset = 0;
    let total = meta.total;
    if (
      parsed.input.section === "activeBundleSeries" &&
      parsed.input.bundleId !== undefined
    ) {
      const filter = parseFilter(
        await getStrong(store, filterKey(job.id, parsed.input.bundleId)),
        job,
        parsed.input.bundleId,
      );
      startOffset = filter?.start ?? 0;
      total = filter?.total ?? 0;
    }
    const nextOrdinal = Number(parsed.nextOrdinal);
    if (!Number.isSafeInteger(nextOrdinal) || nextOrdinal > total) {
      throw new DynamoDBInsightsV2InputError(
        "Invalid DynamoDB Insights report cursor ordinal",
      );
    }
    const physicalStart = startOffset + nextOrdinal;
    const remaining = total - nextOrdinal;
    const readLimit = Math.min(input.limit + 1, remaining);
    const rowsResult =
      readLimit === 0
        ? { Items: undefined }
        : await store.client.send(
            new QueryCommand({
              TableName: store.tableName,
              ConsistentRead: true,
              KeyConditionExpression:
                startOffset === 0 && total === meta.total
                  ? "#pk = :pk AND #sk >= :start"
                  : "#pk = :pk AND #sk BETWEEN :start AND :end",
              ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
              ExpressionAttributeValues: {
                ":pk": meta.runPk,
                ":start": padded(physicalStart),
                ...(startOffset === 0 && total === meta.total
                  ? {}
                  : { ":end": padded(startOffset + total - 1) }),
              },
              Limit: readLimit,
              ScanIndexForward: true,
              ReturnConsumedCapacity: "TOTAL",
            }),
          );
    const stored: Record<string, unknown>[] = rowsResult.Items ?? [];
    if (stored.length !== readLimit) {
      throw new DynamoDBInsightsV2StorageCorruptionError(
        "DynamoDB Insights report section has a gap",
      );
    }
    let rows = stored
      .slice(0, input.limit)
      .map((value, index) =>
        storedPageRow(value, meta.runPk, physicalStart + index),
      );
    for (;;) {
      const logicalNext = nextOrdinal + rows.length;
      const hasNext = logicalNext < total;
      const nextCursor = hasNext
        ? createInsightsReportPageCursor(
            input,
            String(logicalNext),
            dynamoDBInsightsV2Namespace(store),
          )
        : null;
      const data = {
        data: rows,
        nextCursor,
        hasNext,
        consistency: {
          kind: "snapshot" as const,
          cutoff: {
            kind: "publication" as const,
            publication: snapshotPublication(job),
          },
        },
        total: {
          state: "exact" as const,
          value: total,
          sourceGeneration: job.source_generation,
        },
        section: parsed.input.section,
        ...(metric === "" ? {} : { metric }),
      };
      const result = {
        state: "ready" as const,
        versions: versions(job.source_generation, job.id),
        data,
      };
      if (
        getCanonicalInsightsJsonByteLength(result) <= INSIGHTS_PAGE_MAX_BYTES
      ) {
        assertInsightsReportPageResultContract(result, input.limit);
        return result;
      }
      if (rows.length <= 1) {
        throw new DynamoDBInsightsV2StorageCorruptionError(
          `DynamoDB Insights report row exceeds ${DYNAMODB_INSIGHTS_PAGE_MAX_BYTES} bytes`,
        );
      }
      rows = rows.slice(0, -1);
    }
  } catch (error) {
    if (isPublicationCorruption(error)) {
      const result = storageCorruptionResult(job);
      assertInsightsReportPageResultContract(result, input.limit);
      return result;
    }
    throw error;
  }
};

export type DynamoDBInsightsModel = InsightsModel & {
  readonly maintenance: ReturnType<
    typeof createDynamoDBInsightsV2
  >["maintenance"] & {
    runJob(
      input: RunDynamoDBInsightsJobInput,
    ): Promise<DynamoDBInsightsJobStep>;
  };
};

export const createDynamoDBInsightsModel = (
  store: DynamoDBInsightsV2Store,
): DynamoDBInsightsModel => {
  dynamoDBInsightsV2Namespace(store);
  const base = createDynamoDBInsightsV2(store);
  async function pageInstallations(
    input: InsightsLiveInstallationPageInput,
  ): Promise<InsightsLiveInstallationPage>;
  async function pageInstallations(
    input: InsightsInitialPublishedInstallationPageInput,
  ): Promise<InsightsInitialPublishedInstallationPage>;
  async function pageInstallations(
    input: InsightsPinnedInstallationPageInput,
  ): Promise<InsightsPinnedInstallationPage>;
  async function pageInstallations(
    input: InsightsPublishedInstallationContinuationInput,
  ): Promise<InsightsPublishedInstallationContinuation>;
  async function pageInstallations(
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage>;
  async function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage>;
  async function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage> {
    const canonical = readInsightsInstallationPageInput(input);
    return canonical.kind === "all" || canonical.kind === "installationId"
      ? pageDynamoDBInsightsInstallationsCanonical(store, canonical)
      : pagePublishedInstallations(store, canonical);
  }
  return {
    append: base.append,
    pageEvents: (input) => pageDynamoDBInsightsEvents(store, input),
    pageInstallations,
    getReport: (input) => getDynamoDBInsightsReport(store, input),
    pageReport: (input) => pageDynamoDBInsightsReport(store, input),
    maintenance: {
      ...base.maintenance,
      runJob: (input) => runDynamoDBInsightsJobStep(store, input),
    },
  };
};
