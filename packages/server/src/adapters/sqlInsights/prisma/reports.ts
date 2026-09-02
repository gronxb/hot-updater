import {
  DatabasePluginInputError,
  type BundleEventRow,
  type InsightsFailedRead,
  type InsightsPublishedReportPageData,
  type InsightsReportInput,
  type InsightsReportPage,
  type InsightsReportPageInput,
  type InsightsReportPublication,
  type InsightsReportQuery,
  type InsightsReportResult,
} from "@hot-updater/plugin-core";
import {
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_MAINTENANCE_MAX_ITEMS,
  INSIGHTS_MAINTENANCE_MAX_REQUESTS,
  assertInsightsReportPageResultContract,
  assertInsightsReportResultContract,
  canonicalInsightsJson,
  createInsightsReportPageCursor,
  createInsightsReportProjection,
  getCanonicalInsightsJsonByteLength,
  readInsightsReportPageInput,
  readInsightsReportPageQuery,
  readInsightsReportQuery,
  type InsightsReportProjection,
} from "@hot-updater/plugin-core/internal";

import type { ORMSQLProvider } from "../../../db/types";
import {
  PrismaInsightsSql,
  executePrismaInsights,
  queryPrismaInsights,
  runPrismaInsightsTransaction,
  type PrismaInsightsClient,
  type PrismaInsightsRawClient,
} from "./client";
import {
  parsePrismaInsightsEventJson,
  prismaInsightsInstallKey,
} from "./codec";
import {
  insertPrismaInsightsIgnore,
  selectPrismaInsightsRows,
  updatePrismaInsightsRows,
} from "./rawStore";
import {
  PRISMA_INSIGHTS_EVENTS,
  PRISMA_INSIGHTS_REPORT_COUNTS,
  PRISMA_INSIGHTS_REPORT_HEADS,
  PRISMA_INSIGHTS_REPORT_JOBS,
  PRISMA_INSIGHTS_REPORT_LATEST,
  PRISMA_INSIGHTS_REPORT_MEMBERS,
  PRISMA_INSIGHTS_REPORT_ORDER,
  PRISMA_INSIGHTS_REPORT_SEALS,
  PRISMA_INSIGHTS_REPORT_SORT,
} from "./schema";
import {
  readPrismaInsightsState,
  readReadyPrismaInsightsState,
} from "./source";
import {
  newPrismaInsightsId,
  prismaInsightsDigest,
  prismaInsightsPublication,
  prismaInsightsReadVersions,
  prismaInsightsSafeInteger,
  readPrismaInsightsDatabaseTime,
} from "./utils";

type ReportPhase =
  | "source"
  | "members"
  | "installations"
  | "order"
  | "seal"
  | "publish";

type ReportJob = {
  id: string;
  query_key: Uint8Array;
  query_json: string;
  state: "queued" | "preparing" | "ready" | "failed";
  phase: ReportPhase;
  source_generation: unknown;
  as_of_ms: unknown;
  completed_at_ms: unknown | null;
  after_generation: unknown;
  after_key: Uint8Array | null;
  order_phase: unknown;
  order_totals_json: string;
  publication_json: string | null;
  manifest_json: string | null;
  manifest_digest: Uint8Array | null;
  failure_json: string | null;
  lease_owner: string | null;
  lease_version: unknown;
};

type ReportHead = {
  query_key: Uint8Array;
  query_json: string;
  active_job_id: string | null;
  publication_job_id: string | null;
};

type SourceRow = { source_generation: unknown; event_json: string };
type MemberRow = {
  member_key: Uint8Array;
  section: string;
  metric: string;
  label: string;
  bucket_start_ms: unknown;
  install_id: string;
};
type LatestRow = {
  install_key: Uint8Array;
  bucket_index: unknown;
  received_at_ms: unknown;
  event_id: string;
  event_json: string;
};
type CountRow = {
  count_key: Uint8Array;
  section: string;
  metric: string;
  label: string;
  label_order: Uint8Array;
  bucket_start_ms: unknown;
  value: unknown;
};
type OrderRow = { ordinal: unknown; label: string; value: unknown };
type SortRow = { ordinal: unknown; label: string; value: unknown };
type SortKeyRow = {
  sort_pass: unknown;
  sort_run: unknown;
  ordinal: unknown;
};
type SealRow = {
  seal_kind: string;
  seal_key: Uint8Array;
  row_digest: Uint8Array;
};

const jobColumns = [
  "id",
  "query_key",
  "query_json",
  "state",
  "phase",
  "source_generation",
  "as_of_ms",
  "completed_at_ms",
  "after_generation",
  "after_key",
  "order_phase",
  "order_totals_json",
  "publication_json",
  "manifest_json",
  "manifest_digest",
  "failure_json",
  "lease_owner",
  "lease_version",
] as const;

class PrismaInsightsSourceNotReadyError extends Error {
  constructor(readonly failure: InsightsFailedRead) {
    super(failure.error.code);
  }
}
class PrismaInsightsReportPoisonError extends DatabasePluginInputError {
  constructor() {
    super("invalid-result");
  }
}

const validatedReportResult = (
  value: InsightsReportResult,
): InsightsReportResult => {
  assertInsightsReportResultContract(value);
  return value;
};

const validatedReportPage = (
  value: InsightsReportPage,
  requestedLimit: number,
): InsightsReportPage => {
  assertInsightsReportPageResultContract(value, requestedLimit);
  return value;
};

const signedSafeInteger = (value: unknown): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new DatabasePluginInputError("invalid-result");
  return result;
};

const exactNumber = (value: bigint): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new DatabasePluginInputError("invalid-result");
  return result;
};

const reportJobFence = (job: ReportJob) => {
  if (job.lease_owner === null)
    throw new DatabasePluginInputError("invalid-result");
  return {
    id: job.id,
    lease_owner: job.lease_owner,
    lease_version: prismaInsightsSafeInteger(job.lease_version),
  } as const;
};

const jsStringOrderKey = (value: string): Buffer => {
  const key = Buffer.alloc(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    key.writeUInt16BE(value.charCodeAt(index), index * 2);
  }
  return key;
};

const countKey = (
  section: string,
  metric: string,
  label: string,
  bucketStartMs: number,
): Buffer => prismaInsightsDigest([section, metric, label, bucketStartMs]);

type CountIdentity = {
  readonly key: Buffer;
  readonly section: string;
  readonly metric: string;
  readonly label: string;
  readonly bucketStartMs: number;
};

const countIdentity = (
  section: string,
  metric: string,
  label: string,
  bucketStartMs: number,
): CountIdentity => ({
  key: countKey(section, metric, label, bucketStartMs),
  section,
  metric,
  label,
  bucketStartMs,
});

const summaryCountIdentities = (
  query: InsightsReportQuery,
): readonly CountIdentity[] => {
  switch (query.kind) {
    case "bundleSummaries":
      return query.bundleIds.flatMap((bundleId) => [
        countIdentity("summary", "installed", bundleId, -1),
        countIdentity("summary", "recovered", bundleId, -1),
      ]);
    case "bundleDetail":
      return [
        countIdentity("summary", "installed", query.bundleId, -1),
        countIdentity("summary", "recovered", query.bundleId, -1),
      ];
    case "installationOverview":
    case "activeOverview":
      return [countIdentity("summary", "", "", -1)];
  }
};

const memberKey = (
  section: string,
  metric: string,
  label: string,
  bucketStartMs: number,
  installId: string,
): Buffer =>
  prismaInsightsDigest([section, metric, label, bucketStartMs, installId]);

const readJob = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  id: string,
): Promise<ReportJob | undefined> =>
  (
    await selectPrismaInsightsRows<ReportJob>(client, provider, {
      table: PRISMA_INSIGHTS_REPORT_JOBS,
      columns: jobColumns,
      where: { id },
      limit: 1,
    })
  )[0];

const readHead = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  queryKey: Buffer,
): Promise<ReportHead | undefined> =>
  (
    await selectPrismaInsightsRows<ReportHead>(client, provider, {
      table: PRISMA_INSIGHTS_REPORT_HEADS,
      columns: [
        "query_key",
        "query_json",
        "active_job_id",
        "publication_job_id",
      ],
      where: { query_key: queryKey },
      limit: 1,
    })
  )[0];

const parseQuery = (job: ReportJob): InsightsReportQuery => {
  let value: unknown;
  try {
    value = JSON.parse(job.query_json);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  return readInsightsReportQuery({ query: value as InsightsReportQuery }).query;
};

const verifyJob = (
  job: ReportJob,
  queryKey: Buffer,
  queryJson: string,
): void => {
  if (
    !Buffer.from(job.query_key).equals(queryKey) ||
    job.query_json !== queryJson
  )
    throw new DatabasePluginInputError("invalid-result");
};

const versions = (job: ReportJob) =>
  prismaInsightsReadVersions(
    prismaInsightsSafeInteger(job.source_generation),
    job.id,
  );

const readPublication = (job: ReportJob): InsightsReportPublication => {
  if (job.state !== "ready" || job.publication_json === null)
    throw new DatabasePluginInputError("invalid-result");
  let value: unknown;
  try {
    value = JSON.parse(job.publication_json);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "id") !== job.id ||
    Reflect.get(value, "accuracy") !== "exact"
  )
    throw new DatabasePluginInputError("invalid-result");
  return value as InsightsReportPublication;
};

const readReportManifest = (job: ReportJob): ReportManifest => {
  if (
    job.state !== "ready" ||
    job.manifest_json === null ||
    job.manifest_digest === null
  )
    throw new DatabasePluginInputError("invalid-result");
  let value: unknown;
  try {
    value = JSON.parse(job.manifest_json);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !==
      "countDigest,countPeaks,countRoot,countRows,orderDigest,orderRows,orderTotals,publicationDigest,revision,seriesFirstBuckets" ||
    Reflect.get(value, "revision") !== 3
  )
    throw new DatabasePluginInputError("invalid-result");
  const countRows = orderInteger(Reflect.get(value, "countRows"));
  const orderRows = orderInteger(Reflect.get(value, "orderRows"));
  const countDigest = Reflect.get(value, "countDigest");
  const countRoot = Reflect.get(value, "countRoot");
  const orderDigest = Reflect.get(value, "orderDigest");
  const publicationDigest = Reflect.get(value, "publicationDigest");
  const rawTotals = Reflect.get(value, "orderTotals");
  const rawSeriesFirstBuckets = Reflect.get(value, "seriesFirstBuckets");
  if (
    typeof countDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(countDigest) ||
    typeof countRoot !== "string" ||
    !/^[0-9a-f]{64}$/.test(countRoot) ||
    typeof orderDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(orderDigest) ||
    typeof publicationDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(publicationDigest) ||
    typeof rawTotals !== "object" ||
    rawTotals === null ||
    Array.isArray(rawTotals) ||
    typeof rawSeriesFirstBuckets !== "object" ||
    rawSeriesFirstBuckets === null ||
    Array.isArray(rawSeriesFirstBuckets)
  )
    throw new DatabasePluginInputError("invalid-result");
  const orderTotals: Record<string, number> = {};
  for (const [key, raw] of Object.entries(rawTotals)) {
    orderTotals[key] = orderInteger(raw);
  }
  const seriesFirstBuckets: Record<string, number> = {};
  for (const [key, raw] of Object.entries(rawSeriesFirstBuckets)) {
    seriesFirstBuckets[key] = signedSafeInteger(raw);
  }
  const countPeaks = readCountPeaks(
    countRows,
    Reflect.get(value, "countPeaks"),
  );
  const manifest: ReportManifest = {
    revision: 3,
    countRows,
    countPeaks,
    countRoot,
    orderRows,
    countDigest,
    orderDigest,
    orderTotals,
    publicationDigest,
    seriesFirstBuckets,
  };
  const canonical = canonicalInsightsJson(manifest);
  const expectedDigest = prismaInsightsDigest([
    "prisma-report-manifest-v3",
    job.query_json,
    prismaInsightsSafeInteger(job.source_generation),
    prismaInsightsSafeInteger(job.as_of_ms),
    canonical,
  ]);
  const orderState = readOrderState(job);
  const seal = orderState.seal;
  if (
    canonical !== job.manifest_json ||
    !expectedDigest.equals(Buffer.from(job.manifest_digest)) ||
    !seal ||
    seal.stage !== "complete" ||
    canonicalInsightsJson(orderState.totals) !==
      canonicalInsightsJson(orderTotals) ||
    seal.countRows !== countRows ||
    canonicalInsightsJson(seal.countPeaks) !==
      canonicalInsightsJson(countPeaks) ||
    countCommitmentRoot(countRows, countPeaks) !== countRoot ||
    seal.orderRows !== orderRows ||
    seal.countDigest !== countDigest ||
    seal.orderDigest !== orderDigest ||
    job.publication_json === null ||
    prismaInsightsDigest([
      "prisma-report-publication-v1",
      job.publication_json,
    ]).toString("hex") !== publicationDigest ||
    canonicalInsightsJson(seal.seriesFirstBuckets) !==
      canonicalInsightsJson(seriesFirstBuckets) ||
    orderRows !==
      Object.values(orderTotals).reduce((total, rows) => total + rows, 0)
  )
    throw new DatabasePluginInputError("invalid-result");
  return manifest;
};

const reportFailureCode = (
  job: ReportJob,
): "migration-poison" | "preparation-failed" | "storage-corruption" => {
  try {
    const failure: unknown = JSON.parse(job.failure_json ?? "null");
    const code =
      typeof failure === "object" && failure !== null
        ? Reflect.get(failure, "code")
        : undefined;
    return code === "migration-poison" || code === "storage-corruption"
      ? code
      : "preparation-failed";
  } catch {
    return "preparation-failed";
  }
};

const reserveReport = async (
  client: PrismaInsightsClient,
  provider: ORMSQLProvider,
  databaseNamespace: string,
  input: InsightsReportInput,
): Promise<{
  readonly job: ReportJob;
  readonly previous: ReportJob | null;
}> => {
  const canonical = readInsightsReportQuery(input);
  const queryJson = JSON.stringify(canonical.query);
  const queryKey = prismaInsightsDigest([
    "prisma-report-1",
    canonical.semanticKey,
  ]);
  return runPrismaInsightsTransaction(client, provider, async (transaction) => {
    const source = await readReadyPrismaInsightsState(
      transaction,
      provider,
      databaseNamespace,
    );
    if ("state" in source) throw new PrismaInsightsSourceNotReadyError(source);
    await insertPrismaInsightsIgnore(
      transaction,
      provider,
      PRISMA_INSIGHTS_REPORT_HEADS,
      {
        query_key: queryKey,
        query_json: queryJson,
        active_job_id: null,
        publication_job_id: null,
      },
      ["query_key"],
    );
    const head = await readHead(transaction, provider, queryKey);
    if (!head || head.query_json !== queryJson)
      throw new DatabasePluginInputError("invalid-result");
    let previous: ReportJob | null = null;
    if (head.publication_job_id) {
      previous =
        (await readJob(transaction, provider, head.publication_job_id)) ?? null;
      if (!previous) throw new DatabasePluginInputError("invalid-result");
      verifyJob(previous, queryKey, queryJson);
      if (
        previous.state === "ready" &&
        (canonical.minAsOfMs === undefined ||
          prismaInsightsSafeInteger(previous.as_of_ms) >= canonical.minAsOfMs)
      )
        return { job: previous, previous: null };
      if (
        previous.state === "failed" &&
        reportFailureCode(previous) === "storage-corruption"
      )
        return { job: previous, previous: null };
    }
    if (head.active_job_id) {
      const active = await readJob(transaction, provider, head.active_job_id);
      if (
        active &&
        (active.state === "queued" ||
          active.state === "preparing" ||
          active.state === "failed")
      ) {
        verifyJob(active, queryKey, queryJson);
        return { job: active, previous };
      }
    }
    const id = newPrismaInsightsId();
    const asOfMs = await readPrismaInsightsDatabaseTime(transaction, provider);
    const jobInserted = await insertPrismaInsightsIgnore(
      transaction,
      provider,
      PRISMA_INSIGHTS_REPORT_JOBS,
      {
        id,
        query_key: queryKey,
        query_json: queryJson,
        state: "queued",
        phase: "source",
        source_generation: prismaInsightsSafeInteger(source.generation),
        as_of_ms: asOfMs,
        completed_at_ms: null,
        after_generation: 0,
        after_key: null,
        order_phase: 0,
        order_totals_json: canonicalInsightsJson({ totals: {}, work: null }),
        publication_json: null,
        manifest_json: null,
        manifest_digest: null,
        failure_json: null,
        lease_owner: null,
        lease_version: 0,
      },
      ["id"],
    );
    if (jobInserted !== 1) throw new DatabasePluginInputError("invalid-result");
    const changed = await updatePrismaInsightsRows(
      transaction,
      provider,
      PRISMA_INSIGHTS_REPORT_HEADS,
      { active_job_id: id },
      { query_key: queryKey, active_job_id: null },
    );
    if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
    const job = await readJob(transaction, provider, id);
    if (!job) throw new DatabasePluginInputError("invalid-result");
    return { job, previous };
  });
};

const failReadyReportResult = async (
  client: PrismaInsightsClient,
  provider: ORMSQLProvider,
  job: ReportJob,
): Promise<InsightsReportResult> => {
  await runPrismaInsightsTransaction(client, provider, async (transaction) => {
    const changed = await updatePrismaInsightsRows(
      transaction,
      provider,
      PRISMA_INSIGHTS_REPORT_JOBS,
      {
        state: "failed",
        failure_json: canonicalInsightsJson({ code: "storage-corruption" }),
        lease_owner: null,
      },
      { id: job.id, state: "ready" },
    );
    if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
  });
  return validatedReportResult({
    state: "failed",
    versions: versions(job),
    error: { code: "storage-corruption" },
  });
};

export const createPrismaInsightsReports = (
  client: PrismaInsightsClient,
  provider: ORMSQLProvider,
  databaseNamespace: string,
) => ({
  async getReport(input: InsightsReportInput): Promise<InsightsReportResult> {
    readInsightsReportQuery(input);
    let reservation: Awaited<ReturnType<typeof reserveReport>>;
    try {
      reservation = await reserveReport(
        client,
        provider,
        databaseNamespace,
        input,
      );
    } catch (error) {
      if (!(error instanceof PrismaInsightsSourceNotReadyError)) throw error;
      return validatedReportResult(error.failure);
    }
    const job = reservation.job;
    if (job.state === "ready") {
      let publication: InsightsReportPublication;
      try {
        publication = readPublication(job);
        const manifest = readReportManifest(job);
        await runPrismaInsightsTransaction(
          client,
          provider,
          async (transaction) =>
            verifyPublishedSummary(
              transaction,
              provider,
              job,
              parseQuery(job),
              publication,
              manifest,
            ),
        );
      } catch (error) {
        if (
          error instanceof DatabasePluginInputError &&
          error.code === "invalid-result"
        )
          return failReadyReportResult(client, provider, job);
        throw error;
      }
      const result = {
        state: "ready" as const,
        versions: versions(job),
        data: publication,
      };
      return validatedReportResult(result);
    }
    if (reservation.previous?.state === "ready") {
      let publication: InsightsReportPublication;
      try {
        publication = readPublication(reservation.previous);
        const manifest = readReportManifest(reservation.previous);
        await runPrismaInsightsTransaction(
          client,
          provider,
          async (transaction) =>
            verifyPublishedSummary(
              transaction,
              provider,
              reservation.previous!,
              parseQuery(reservation.previous!),
              publication,
              manifest,
            ),
        );
      } catch (error) {
        if (
          error instanceof DatabasePluginInputError &&
          error.code === "invalid-result"
        )
          return failReadyReportResult(client, provider, reservation.previous);
        throw error;
      }
      return validatedReportResult({
        state: "stale",
        versions: versions(reservation.previous),
        data: publication,
        refresh: { id: job.id },
      });
    }
    if (job.state === "failed") {
      const code = reportFailureCode(job);
      return validatedReportResult({
        state: "failed",
        versions: versions(job),
        error:
          code === "storage-corruption" ? { code } : { code, jobId: job.id },
      });
    }
    return validatedReportResult({
      state: "preparing",
      versions: versions(job),
      job: { id: job.id },
    });
  },
  pageReport: (input: InsightsReportPageInput) =>
    pagePrismaInsightsReport(client, provider, databaseNamespace, input),
});

const addMember = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  section: string,
  metric: string,
  label: string,
  bucketStartMs: number,
  installId: string,
): Promise<void> => {
  const key = memberKey(section, metric, label, bucketStartMs, installId);
  const inserted = await insertPrismaInsightsIgnore(
    client,
    provider,
    PRISMA_INSIGHTS_REPORT_MEMBERS,
    {
      job_id: jobId,
      member_key: key,
      section,
      metric,
      label,
      bucket_start_ms: bucketStartMs,
      install_id: installId,
    },
    ["job_id", "member_key"],
  );
  if (inserted === 1) return;
  const existing = (
    await selectPrismaInsightsRows<MemberRow>(client, provider, {
      table: PRISMA_INSIGHTS_REPORT_MEMBERS,
      columns: [
        "member_key",
        "section",
        "metric",
        "label",
        "bucket_start_ms",
        "install_id",
      ],
      where: { job_id: jobId, member_key: key },
      limit: 1,
    })
  )[0];
  if (
    !existing ||
    !Buffer.from(existing.member_key).equals(key) ||
    existing.section !== section ||
    existing.metric !== metric ||
    existing.label !== label ||
    signedSafeInteger(existing.bucket_start_ms) !== bucketStartMs ||
    existing.install_id !== installId
  )
    throw new DatabasePluginInputError("invalid-result");
};

const saveLatest = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  bucketIndex: number,
  event: BundleEventRow,
): Promise<void> => {
  const installKey = prismaInsightsInstallKey(event.install_id);
  const current = (
    await selectPrismaInsightsRows<LatestRow>(client, provider, {
      table: PRISMA_INSIGHTS_REPORT_LATEST,
      columns: [
        "install_key",
        "bucket_index",
        "received_at_ms",
        "event_id",
        "event_json",
      ],
      where: {
        job_id: jobId,
        install_key: installKey,
        bucket_index: bucketIndex,
      },
      limit: 1,
    })
  )[0];
  if (current) {
    const stored = parsePrismaInsightsEventJson(current.event_json);
    if (stored.install_id !== event.install_id)
      throw new DatabasePluginInputError("invalid-result");
    if (
      prismaInsightsSafeInteger(current.received_at_ms) >
        event.received_at_ms ||
      (prismaInsightsSafeInteger(current.received_at_ms) ===
        event.received_at_ms &&
        current.event_id >= event.id)
    )
      return;
    const changed = await updatePrismaInsightsRows(
      client,
      provider,
      PRISMA_INSIGHTS_REPORT_LATEST,
      {
        received_at_ms: event.received_at_ms,
        event_id: event.id,
        event_json: canonicalInsightsJson(event),
      },
      { job_id: jobId, install_key: installKey, bucket_index: bucketIndex },
    );
    if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
    return;
  }
  const inserted = await insertPrismaInsightsIgnore(
    client,
    provider,
    PRISMA_INSIGHTS_REPORT_LATEST,
    {
      job_id: jobId,
      install_key: installKey,
      bucket_index: bucketIndex,
      received_at_ms: event.received_at_ms,
      event_id: event.id,
      event_json: canonicalInsightsJson(event),
    },
    ["job_id", "install_key", "bucket_index"],
  );
  if (inserted !== 1) {
    const collision = (
      await selectPrismaInsightsRows<LatestRow>(client, provider, {
        table: PRISMA_INSIGHTS_REPORT_LATEST,
        columns: [
          "install_key",
          "bucket_index",
          "received_at_ms",
          "event_id",
          "event_json",
        ],
        where: {
          job_id: jobId,
          install_key: installKey,
          bucket_index: bucketIndex,
        },
        limit: 1,
      })
    )[0];
    if (
      !collision ||
      parsePrismaInsightsEventJson(collision.event_json).install_id !==
        event.install_id
    )
      throw new DatabasePluginInputError("invalid-result");
  }
};

const saveProjection = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  query: InsightsReportQuery,
  projection: InsightsReportProjection,
  firstBucketMs: number | null,
  bucketSizeMs: number,
): Promise<void> => {
  if (projection.kind === "movement") {
    await addMember(
      client,
      provider,
      job.id,
      "summary",
      projection.metric,
      projection.bundleId,
      -1,
      projection.installId,
    );
    await addMember(
      client,
      provider,
      job.id,
      "movementSeries",
      projection.metric,
      projection.bundleId,
      projection.bucketStartMs,
      projection.installId,
    );
    if (query.kind === "bundleDetail") {
      await addMember(
        client,
        provider,
        job.id,
        "movementCohorts",
        projection.metric,
        projection.cohort,
        -1,
        projection.installId,
      );
    }
    return;
  }
  await saveLatest(client, provider, job.id, -1, projection.event);
  if (projection.bucketStartMs !== null) {
    await saveLatest(
      client,
      provider,
      job.id,
      Math.floor((projection.bucketStartMs - firstBucketMs!) / bucketSizeMs),
      projection.event,
    );
  }
};

const incrementCount = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  section: string,
  metric: string,
  label: string,
  bucketStartMs: number,
): Promise<void> => {
  const key = countKey(section, metric, label, bucketStartMs);
  const current = (
    await selectPrismaInsightsRows<CountRow>(client, provider, {
      table: PRISMA_INSIGHTS_REPORT_COUNTS,
      columns: [
        "count_key",
        "section",
        "metric",
        "label",
        "label_order",
        "bucket_start_ms",
        "value",
      ],
      where: { job_id: jobId, count_key: key },
      limit: 1,
    })
  )[0];
  if (!current) {
    const inserted = await insertPrismaInsightsIgnore(
      client,
      provider,
      PRISMA_INSIGHTS_REPORT_COUNTS,
      {
        job_id: jobId,
        count_key: key,
        section,
        metric,
        label,
        label_order: jsStringOrderKey(label),
        bucket_start_ms: bucketStartMs,
        value: 1,
      },
      ["job_id", "count_key"],
    );
    if (inserted === 1) return;
    throw new DatabasePluginInputError("invalid-result");
  }
  if (
    current.section !== section ||
    current.metric !== metric ||
    current.label !== label ||
    signedSafeInteger(current.bucket_start_ms) !== bucketStartMs
  )
    throw new DatabasePluginInputError("invalid-result");
  const value = prismaInsightsSafeInteger(current.value);
  const changed = await updatePrismaInsightsRows(
    client,
    provider,
    PRISMA_INSIGHTS_REPORT_COUNTS,
    { value: value + 1 },
    { job_id: jobId, count_key: key, value },
  );
  if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
};

const readSourcePage = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  limit: number,
): Promise<SourceRow[]> => {
  const sql = new PrismaInsightsSql(provider);
  const after = sql.value(prismaInsightsSafeInteger(job.after_generation));
  const upper = sql.value(prismaInsightsSafeInteger(job.source_generation));
  const limitMarker = sql.value(limit);
  const top = provider === "mssql" ? `top (${limitMarker}) ` : "";
  const suffix = provider === "mssql" ? "" : ` limit ${limitMarker}`;
  const sourceIndex =
    provider === "mysql"
      ? " force index (source_generation)"
      : provider === "mssql"
        ? " with (forceseek)"
        : "";
  return queryPrismaInsights<SourceRow[]>(
    client,
    sql.statement(
      `select ${top}source_generation,event_json from ${PRISMA_INSIGHTS_EVENTS}${sourceIndex}
       where source_generation>${after} and source_generation<=${upper}
       order by source_generation asc${suffix}`,
    ),
  );
};

const processSource = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  query: InsightsReportQuery,
  capacity: number,
): Promise<number> => {
  const source = await readSourcePage(client, provider, job, capacity);
  const rows: SourceRow[] = [];
  for (const row of source) {
    const normalized = {
      source_generation: prismaInsightsSafeInteger(row.source_generation),
      event_json: row.event_json,
    };
    if (
      getCanonicalInsightsJsonByteLength([...rows, normalized]) >
      INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
    )
      break;
    rows.push(normalized);
  }
  if (source.length > 0 && rows.length === 0)
    throw new DatabasePluginInputError("invalid-result");
  const projector = createInsightsReportProjection(
    query,
    prismaInsightsSafeInteger(job.as_of_ms),
  );
  for (const row of rows) {
    let event: BundleEventRow;
    try {
      event = parsePrismaInsightsEventJson(row.event_json);
    } catch (error) {
      if (!(error instanceof DatabasePluginInputError)) throw error;
      throw new PrismaInsightsReportPoisonError();
    }
    const projected = projector.project(event);
    if (projected)
      await saveProjection(
        client,
        provider,
        job,
        query,
        projected,
        projector.firstBucketMs,
        projector.bucketSizeMs,
      );
  }
  const last = rows.at(-1);
  const exhausted = rows.length === source.length && source.length < capacity;
  const phase = exhausted
    ? query.kind === "bundleSummaries" || query.kind === "bundleDetail"
      ? "members"
      : "installations"
    : "source";
  const changed = await updatePrismaInsightsRows(
    client,
    provider,
    PRISMA_INSIGHTS_REPORT_JOBS,
    {
      state: "preparing",
      phase,
      after_generation:
        phase === "installations"
          ? 0
          : last === undefined
            ? prismaInsightsSafeInteger(job.after_generation)
            : prismaInsightsSafeInteger(last.source_generation),
      after_key: null,
    },
    reportJobFence(job),
  );
  if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
  return rows.length;
};

const processMembers = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  capacity: number,
): Promise<number> => {
  const rows = await selectPrismaInsightsRows<MemberRow>(client, provider, {
    table: PRISMA_INSIGHTS_REPORT_MEMBERS,
    columns: [
      "member_key",
      "section",
      "metric",
      "label",
      "bucket_start_ms",
      "install_id",
    ],
    where: {
      job_id: job.id,
      ...(job.after_key === null
        ? {}
        : {
            member_key: {
              operator: "gt",
              value: Buffer.from(job.after_key),
            } as const,
          }),
    },
    orderBy: [{ column: "member_key", direction: "asc" }],
    limit: capacity,
  });
  for (const row of rows) {
    const bucketStartMs = signedSafeInteger(row.bucket_start_ms);
    if (
      !Buffer.from(row.member_key).equals(
        memberKey(
          row.section,
          row.metric,
          row.label,
          bucketStartMs,
          row.install_id,
        ),
      )
    ) {
      throw new DatabasePluginInputError("invalid-result");
    }
    await incrementCount(
      client,
      provider,
      job.id,
      row.section,
      row.metric,
      row.label,
      bucketStartMs,
    );
  }
  const last = rows.at(-1);
  const changed = await updatePrismaInsightsRows(
    client,
    provider,
    PRISMA_INSIGHTS_REPORT_JOBS,
    {
      phase: rows.length < capacity ? "order" : "members",
      after_key: last ? Buffer.from(last.member_key) : job.after_key,
    },
    reportJobFence(job),
  );
  if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
  return rows.length;
};

const processInstallations = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  query: Extract<
    InsightsReportQuery,
    { kind: "installationOverview" | "activeOverview" }
  >,
  maxItems: number,
  maxRequests: number,
): Promise<number> => {
  const projection = createInsightsReportProjection(
    query,
    prismaInsightsSafeInteger(job.as_of_ms),
  );
  const progress = orderInteger(job.after_generation);
  if (progress === 0) {
    const row = (
      await selectPrismaInsightsRows<LatestRow>(client, provider, {
        table: PRISMA_INSIGHTS_REPORT_LATEST,
        columns: [
          "install_key",
          "bucket_index",
          "received_at_ms",
          "event_id",
          "event_json",
        ],
        where: {
          job_id: job.id,
          bucket_index: -1,
          ...(job.after_key === null
            ? {}
            : {
                install_key: {
                  operator: "gt",
                  value: Buffer.from(job.after_key),
                } as const,
              }),
        },
        orderBy: [{ column: "install_key", direction: "asc" }],
        limit: 1,
      })
    )[0];
    if (!row) {
      const changed = await updatePrismaInsightsRows(
        client,
        provider,
        PRISMA_INSIGHTS_REPORT_JOBS,
        { phase: "order", after_generation: 0 },
        reportJobFence(job),
      );
      if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
      return 0;
    }
    const latest = parsePrismaInsightsEventJson(row.event_json);
    if (
      !Buffer.from(row.install_key).equals(
        prismaInsightsInstallKey(latest.install_id),
      )
    )
      throw new DatabasePluginInputError("invalid-result");
    if (
      query.kind === "activeOverview" &&
      query.userId !== undefined &&
      latest.user_id !== query.userId
    ) {
      const changed = await updatePrismaInsightsRows(
        client,
        provider,
        PRISMA_INSIGHTS_REPORT_JOBS,
        { after_key: Buffer.from(row.install_key), after_generation: 0 },
        reportJobFence(job),
      );
      if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
      return 1;
    }
    await incrementCount(client, provider, job.id, "summary", "", "", -1);
    await incrementCount(
      client,
      provider,
      job.id,
      "bundleDistribution",
      "",
      latest.to_bundle_id,
      -1,
    );
    const changed = await updatePrismaInsightsRows(
      client,
      provider,
      PRISMA_INSIGHTS_REPORT_JOBS,
      {
        after_key: Buffer.from(row.install_key),
        after_generation: query.kind === "activeOverview" ? 1 : 0,
      },
      reportJobFence(job),
    );
    if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
    return 1;
  }

  if (query.kind !== "activeOverview" || job.after_key === null)
    throw new DatabasePluginInputError("invalid-result");
  const capacity = Math.min(
    maxItems,
    Math.floor((maxRequests - 6) / (provider === "mysql" ? 9 : 6)),
  );
  if (capacity < 1) return 0;
  const installKey = Buffer.from(job.after_key);
  const latestRow = (
    await selectPrismaInsightsRows<LatestRow>(client, provider, {
      table: PRISMA_INSIGHTS_REPORT_LATEST,
      columns: [
        "install_key",
        "bucket_index",
        "received_at_ms",
        "event_id",
        "event_json",
      ],
      where: { job_id: job.id, install_key: installKey, bucket_index: -1 },
      limit: 1,
    })
  )[0];
  if (!latestRow) throw new DatabasePluginInputError("invalid-result");
  const latest = parsePrismaInsightsEventJson(latestRow.event_json);
  if (!prismaInsightsInstallKey(latest.install_id).equals(installKey))
    throw new DatabasePluginInputError("invalid-result");
  const buckets = await selectPrismaInsightsRows<LatestRow>(client, provider, {
    table: PRISMA_INSIGHTS_REPORT_LATEST,
    columns: [
      "install_key",
      "bucket_index",
      "received_at_ms",
      "event_id",
      "event_json",
    ],
    where: {
      job_id: job.id,
      install_key: installKey,
      bucket_index: { operator: "gte", value: progress - 1 },
    },
    orderBy: [{ column: "bucket_index", direction: "asc" }],
    limit: capacity,
  });
  for (const bucket of buckets) {
    const bucketIndex = orderInteger(bucket.bucket_index);
    const event = parsePrismaInsightsEventJson(bucket.event_json);
    if (!prismaInsightsInstallKey(event.install_id).equals(installKey))
      throw new DatabasePluginInputError("invalid-result");
    const bucketStartMs =
      projection.firstBucketMs! + bucketIndex * projection.bucketSizeMs;
    await incrementCount(
      client,
      provider,
      job.id,
      "activeSeries",
      "",
      "",
      bucketStartMs,
    );
    await incrementCount(
      client,
      provider,
      job.id,
      "activeBundleSeries",
      "",
      event.to_bundle_id,
      bucketStartMs,
    );
    await incrementCount(
      client,
      provider,
      job.id,
      "activeBundleTotals",
      "",
      event.to_bundle_id,
      -1,
    );
  }
  const last = buckets.at(-1);
  const nextProgress =
    buckets.length < capacity ? 0 : orderInteger(last!.bucket_index) + 2;
  const changed = await updatePrismaInsightsRows(
    client,
    provider,
    PRISMA_INSIGHTS_REPORT_JOBS,
    { after_generation: nextProgress },
    reportJobFence(job),
  );
  if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
  return buckets.length;
};

type OrderSection = {
  readonly kind:
    | "movementCohorts"
    | "bundleDistribution"
    | "activeBundleTotals";
  readonly metric: string;
  readonly byValue: boolean;
};

const orderTotalKey = (kind: string, metric: string): string =>
  canonicalInsightsJson([kind, metric]);

type OrderWork =
  | {
      readonly stage: "runs";
      readonly kind: OrderSection["kind"];
      readonly metric: string;
      readonly afterKey: string | null;
      readonly nextRun: number;
      readonly totalRows: number;
    }
  | {
      readonly stage: "merge";
      readonly kind: OrderSection["kind"];
      readonly metric: string;
      readonly pass: number;
      readonly run: number;
      readonly runCount: number;
      readonly leftOffset: number;
      readonly rightOffset: number;
      readonly outputOffset: number;
      readonly totalRows: number;
    }
  | {
      readonly stage: "finalize";
      readonly kind: OrderSection["kind"];
      readonly metric: string;
      readonly pass: number;
      readonly offset: number;
      readonly totalRows: number;
    }
  | {
      readonly stage: "cleanup";
      readonly kind: OrderSection["kind"];
      readonly metric: string;
      readonly totalRows: number;
    };

type OrderState = {
  readonly totals: Record<string, number>;
  readonly work: OrderWork | null;
  readonly seal?: ReportSealState;
};

type ReportSealState = {
  readonly stage: "counts" | "order" | "complete";
  readonly afterCountKey: string | null;
  readonly orderSection: number;
  readonly orderOrdinal: number;
  readonly countRows: number;
  readonly orderRows: number;
  readonly countDigest: string;
  readonly countPeaks: readonly (string | null)[];
  readonly orderDigest: string;
  readonly seriesFirstBuckets: Record<string, number>;
};

type CountCommitment = {
  readonly countRows: number;
  readonly countPeaks: readonly (string | null)[];
  readonly countRoot: string;
};

type ReportManifest = CountCommitment & {
  readonly revision: 3;
  readonly orderRows: number;
  readonly countDigest: string;
  readonly orderDigest: string;
  readonly orderTotals: Record<string, number>;
  readonly publicationDigest: string;
  readonly seriesFirstBuckets: Record<string, number>;
};

const seriesFirstBucketKey = (section: string, metric: string): string =>
  canonicalInsightsJson([section, metric]);

const emptySealDigest = "0".repeat(64);

const countCommitmentRoot = (
  countRows: number,
  countPeaks: readonly (string | null)[],
): string =>
  prismaInsightsDigest([
    "prisma-report-count-root-v1",
    countRows,
    countPeaks,
  ]).toString("hex");

const readCountPeaks = (
  countRows: number,
  value: unknown,
): readonly (string | null)[] => {
  if (!Array.isArray(value) || value.length > 53)
    throw new DatabasePluginInputError("invalid-result");
  const count = BigInt(countRows);
  const peaks = value.map((peak, level) => {
    const expected = (count & (1n << BigInt(level))) !== 0n;
    if (
      (expected &&
        (typeof peak !== "string" || !/^[0-9a-f]{64}$/.test(peak))) ||
      (!expected && peak !== null)
    )
      throw new DatabasePluginInputError("invalid-result");
    return peak as string | null;
  });
  const highest = peaks.findLastIndex((peak) => peak !== null);
  if (
    (countRows === 0 && peaks.length !== 0) ||
    (countRows > 0 && highest !== peaks.length - 1) ||
    count >> BigInt(peaks.length) !== 0n
  )
    throw new DatabasePluginInputError("invalid-result");
  return peaks;
};

const reportRowDigest = (
  kind: "count" | "order",
  value: readonly unknown[],
): Buffer =>
  prismaInsightsDigest(["prisma-report-derived-row-v1", kind, value]);

const nextSealDigest = (previous: string, rowDigest: Uint8Array): string =>
  prismaInsightsDigest([
    "prisma-report-seal-chain-v1",
    previous,
    Buffer.from(rowDigest).toString("hex"),
  ]).toString("hex");

const countLeafDigest = (
  ordinal: number,
  key: Uint8Array,
  rowDigest: Uint8Array,
): Buffer =>
  prismaInsightsDigest([
    "prisma-report-count-leaf-v1",
    ordinal,
    Buffer.from(key).toString("hex"),
    Buffer.from(rowDigest).toString("hex"),
  ]);

const encodeCountLeafSeal = (ordinal: number, digest: Uint8Array): Buffer => {
  const result = Buffer.alloc(40);
  result.writeBigUInt64BE(BigInt(ordinal));
  Buffer.from(digest).copy(result, 8);
  return result;
};

const readCountLeafSeal = (
  value: Uint8Array,
): { readonly ordinal: number; readonly digest: Buffer } => {
  const encoded = Buffer.from(value);
  if (encoded.length !== 40)
    throw new DatabasePluginInputError("invalid-result");
  const ordinal = Number(encoded.readBigUInt64BE());
  if (!Number.isSafeInteger(ordinal))
    throw new DatabasePluginInputError("invalid-result");
  return { ordinal, digest: encoded.subarray(8) };
};

const countNodeKey = (level: number, ordinal: number): Buffer =>
  prismaInsightsDigest(["prisma-report-count-node-key-v1", level, ordinal]);

const countParentDigest = (
  level: number,
  ordinal: number,
  left: Uint8Array,
  right: Uint8Array,
): Buffer =>
  prismaInsightsDigest([
    "prisma-report-count-node-v1",
    level,
    ordinal,
    Buffer.from(left).toString("hex"),
    Buffer.from(right).toString("hex"),
  ]);

const appendCountPeak = (
  current: readonly (string | null)[],
  ordinal: number,
  leaf: Buffer,
): {
  readonly peaks: readonly (string | null)[];
  readonly nodes: readonly { readonly key: Buffer; readonly digest: Buffer }[];
} => {
  const peaks = [...current];
  const nodes: { key: Buffer; digest: Buffer }[] = [
    { key: countNodeKey(0, ordinal), digest: leaf },
  ];
  let digest = leaf;
  let level = 0;
  while (peaks[level] !== undefined && peaks[level] !== null) {
    const parentLevel = level + 1;
    const parentOrdinal = Math.floor(ordinal / 2 ** parentLevel);
    digest = countParentDigest(
      parentLevel,
      parentOrdinal,
      Buffer.from(peaks[level]!, "hex"),
      digest,
    );
    peaks[level] = null;
    nodes.push({
      key: countNodeKey(parentLevel, parentOrdinal),
      digest,
    });
    level = parentLevel;
  }
  peaks[level] = digest.toString("hex");
  return { peaks, nodes };
};

const orderSealKey = (kind: string, metric: string, ordinal: number): Buffer =>
  prismaInsightsDigest([
    "prisma-report-order-seal-key-v1",
    kind,
    metric,
    ordinal,
  ]);

const orderInteger = (value: unknown): number => {
  const result = prismaInsightsSafeInteger(value);
  if (result < 0) throw new DatabasePluginInputError("invalid-result");
  return result;
};

const orderString = (value: unknown): string => {
  if (typeof value !== "string")
    throw new DatabasePluginInputError("invalid-result");
  return value;
};

const readOrderState = (job: ReportJob): OrderState => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(job.order_totals_json);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new DatabasePluginInputError("invalid-result");
  const rawTotals = Reflect.get(parsed, "totals");
  if (
    typeof rawTotals !== "object" ||
    rawTotals === null ||
    Array.isArray(rawTotals)
  )
    throw new DatabasePluginInputError("invalid-result");
  const totals: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawTotals)) {
    totals[key] = orderInteger(value);
  }
  const rawSeal = Reflect.get(parsed, "seal");
  let seal: ReportSealState | undefined;
  if (rawSeal !== undefined) {
    if (
      typeof rawSeal !== "object" ||
      rawSeal === null ||
      Array.isArray(rawSeal)
    )
      throw new DatabasePluginInputError("invalid-result");
    const stage = Reflect.get(rawSeal, "stage");
    const afterCountKey = Reflect.get(rawSeal, "afterCountKey");
    const countDigest = Reflect.get(rawSeal, "countDigest");
    const rawCountPeaks = Reflect.get(rawSeal, "countPeaks");
    const orderDigest = Reflect.get(rawSeal, "orderDigest");
    const rawSeriesFirstBuckets = Reflect.get(rawSeal, "seriesFirstBuckets");
    if (
      (stage !== "counts" && stage !== "order" && stage !== "complete") ||
      (afterCountKey !== null &&
        (typeof afterCountKey !== "string" ||
          !/^[0-9a-f]{64}$/.test(afterCountKey))) ||
      typeof countDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(countDigest) ||
      typeof orderDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(orderDigest) ||
      typeof rawSeriesFirstBuckets !== "object" ||
      rawSeriesFirstBuckets === null ||
      Array.isArray(rawSeriesFirstBuckets)
    )
      throw new DatabasePluginInputError("invalid-result");
    const seriesFirstBuckets: Record<string, number> = {};
    for (const [key, value] of Object.entries(rawSeriesFirstBuckets)) {
      seriesFirstBuckets[key] = signedSafeInteger(value);
    }
    const countRows = orderInteger(Reflect.get(rawSeal, "countRows"));
    const countPeaks = readCountPeaks(countRows, rawCountPeaks);
    seal = {
      stage,
      afterCountKey,
      orderSection: orderInteger(Reflect.get(rawSeal, "orderSection")),
      orderOrdinal: orderInteger(Reflect.get(rawSeal, "orderOrdinal")),
      countRows,
      orderRows: orderInteger(Reflect.get(rawSeal, "orderRows")),
      countDigest,
      countPeaks,
      orderDigest,
      seriesFirstBuckets,
    };
  }
  const base = { totals, ...(seal === undefined ? {} : { seal }) };
  const rawWork = Reflect.get(parsed, "work");
  if (rawWork === null) return { ...base, work: null };
  if (typeof rawWork !== "object" || rawWork === null || Array.isArray(rawWork))
    throw new DatabasePluginInputError("invalid-result");
  const stage = Reflect.get(rawWork, "stage");
  const kind = orderString(Reflect.get(rawWork, "kind"));
  if (
    kind !== "movementCohorts" &&
    kind !== "bundleDistribution" &&
    kind !== "activeBundleTotals"
  )
    throw new DatabasePluginInputError("invalid-result");
  const common = {
    kind,
    metric: orderString(Reflect.get(rawWork, "metric")),
    totalRows: orderInteger(Reflect.get(rawWork, "totalRows")),
  } as const;
  switch (stage) {
    case "runs": {
      const afterKey = Reflect.get(rawWork, "afterKey");
      if (
        afterKey !== null &&
        (typeof afterKey !== "string" || !/^[0-9a-f]{64}$/.test(afterKey))
      )
        throw new DatabasePluginInputError("invalid-result");
      return {
        ...base,
        work: {
          ...common,
          stage,
          afterKey,
          nextRun: orderInteger(Reflect.get(rawWork, "nextRun")),
        },
      };
    }
    case "merge":
      return {
        ...base,
        work: {
          ...common,
          stage,
          pass: orderInteger(Reflect.get(rawWork, "pass")),
          run: orderInteger(Reflect.get(rawWork, "run")),
          runCount: orderInteger(Reflect.get(rawWork, "runCount")),
          leftOffset: orderInteger(Reflect.get(rawWork, "leftOffset")),
          rightOffset: orderInteger(Reflect.get(rawWork, "rightOffset")),
          outputOffset: orderInteger(Reflect.get(rawWork, "outputOffset")),
        },
      };
    case "finalize":
      return {
        ...base,
        work: {
          ...common,
          stage,
          pass: orderInteger(Reflect.get(rawWork, "pass")),
          offset: orderInteger(Reflect.get(rawWork, "offset")),
        },
      };
    case "cleanup":
      return { ...base, work: { ...common, stage } };
    default:
      throw new DatabasePluginInputError("invalid-result");
  }
};

const orderSections = (query: InsightsReportQuery): readonly OrderSection[] => {
  switch (query.kind) {
    case "bundleSummaries":
      return [];
    case "bundleDetail":
      return [
        { kind: "movementCohorts", metric: "installed", byValue: false },
        { kind: "movementCohorts", metric: "recovered", byValue: false },
      ];
    case "installationOverview":
      return [{ kind: "bundleDistribution", metric: "", byValue: true }];
    case "activeOverview":
      return [
        { kind: "bundleDistribution", metric: "", byValue: true },
        { kind: "activeBundleTotals", metric: "", byValue: true },
      ];
  }
};

type MaterializedOrderRow = { readonly label: string; readonly value: number };

const compareOrderRows = (
  byValue: boolean,
  left: MaterializedOrderRow,
  right: MaterializedOrderRow,
): number => {
  if (byValue && left.value !== right.value)
    return left.value > right.value ? -1 : 1;
  return left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
};

const boundedOrderRows = <T extends MaterializedOrderRow>(
  rows: readonly T[],
  capacity: number,
): T[] => {
  const bounded: T[] = [];
  let bytes = 2;
  for (const row of rows) {
    const rowBytes = getCanonicalInsightsJsonByteLength({
      label: row.label,
      value: row.value,
    });
    const nextBytes = bytes + (bounded.length === 0 ? 0 : 1) + rowBytes;
    if (
      bounded.length >= capacity ||
      nextBytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
    )
      break;
    bounded.push(row);
    bytes = nextBytes;
  }
  if (rows.length > 0 && bounded.length === 0)
    throw new DatabasePluginInputError("invalid-result");
  return bounded;
};

const insertSortRows = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  section: OrderSection,
  pass: number,
  run: number,
  offset: number,
  rows: readonly MaterializedOrderRow[],
): Promise<void> => {
  if (rows.length === 0) return;
  const sql = new PrismaInsightsSql(provider);
  const values = rows.map(
    (row, index) =>
      `(${sql.value(jobId)},${sql.value(section.kind)},${sql.value(
        section.metric,
      )},${sql.value(pass)},${sql.value(run)},${sql.value(
        offset + index,
      )},${sql.value(row.label)},${sql.value(row.value)})`,
  );
  const inserted = await executePrismaInsights(
    client,
    sql.statement(
      `insert into ${PRISMA_INSIGHTS_REPORT_SORT}
       (job_id,order_kind,metric,sort_pass,sort_run,ordinal,label,value)
       values ${values.join(",")}`,
    ),
  );
  if (prismaInsightsSafeInteger(inserted) !== rows.length)
    throw new DatabasePluginInputError("invalid-result");
};

const insertFinalOrderRows = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  section: OrderSection,
  offset: number,
  rows: readonly MaterializedOrderRow[],
): Promise<void> => {
  if (rows.length === 0) return;
  const sql = new PrismaInsightsSql(provider);
  const values = rows.map(
    (row, index) =>
      `(${sql.value(jobId)},${sql.value(section.kind)},${sql.value(
        section.metric,
      )},${sql.value(offset + index)},${sql.value(row.label)},${sql.value(
        row.value,
      )})`,
  );
  const inserted = await executePrismaInsights(
    client,
    sql.statement(
      `insert into ${PRISMA_INSIGHTS_REPORT_ORDER}
       (job_id,order_kind,metric,ordinal,label,value)
       values ${values.join(",")}`,
    ),
  );
  if (prismaInsightsSafeInteger(inserted) !== rows.length)
    throw new DatabasePluginInputError("invalid-result");
};

const readSortRun = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  section: OrderSection,
  pass: number,
  run: number,
  offset: number,
  capacity: number,
): Promise<MaterializedOrderRow[]> => {
  const rows = await selectPrismaInsightsRows<SortRow>(client, provider, {
    table: PRISMA_INSIGHTS_REPORT_SORT,
    columns: ["ordinal", "label", "value"],
    where: {
      job_id: jobId,
      order_kind: section.kind,
      metric: section.metric,
      sort_pass: pass,
      sort_run: run,
      ordinal: { operator: "gte", value: offset },
    },
    orderBy: [{ column: "ordinal", direction: "asc" }],
    limit: capacity,
  });
  return rows.map((row, index) => {
    if (orderInteger(row.ordinal) !== offset + index)
      throw new DatabasePluginInputError("invalid-result");
    return { label: row.label, value: orderInteger(row.value) };
  });
};

const saveOrderState = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  state: OrderState,
  values: Record<string, unknown> = {},
): Promise<void> => {
  const changed = await updatePrismaInsightsRows(
    client,
    provider,
    PRISMA_INSIGHTS_REPORT_JOBS,
    {
      ...values,
      order_totals_json: canonicalInsightsJson(state),
    },
    reportJobFence(job),
  );
  if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
};

const completeOrderSection = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  sections: readonly OrderSection[],
  phase: number,
  section: OrderSection,
  state: OrderState,
  totalRows: number,
): Promise<void> => {
  const totalKey = orderTotalKey(section.kind, section.metric);
  if (totalKey in state.totals)
    throw new DatabasePluginInputError("invalid-result");
  const totals = { ...state.totals, [totalKey]: totalRows };
  const complete = phase + 1 >= sections.length;
  await saveOrderState(
    client,
    provider,
    job,
    {
      totals,
      work: null,
      ...(complete
        ? {
            seal: {
              stage: "counts" as const,
              afterCountKey: null,
              orderSection: 0,
              orderOrdinal: 0,
              countRows: 0,
              orderRows: 0,
              countDigest: emptySealDigest,
              countPeaks: [],
              orderDigest: emptySealDigest,
              seriesFirstBuckets: {},
            },
          }
        : {}),
    },
    {
      order_phase: phase + 1,
      phase: complete ? "seal" : "order",
    },
  );
};

const processOrder = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  query: InsightsReportQuery,
  capacity: number,
): Promise<number> => {
  const sections = orderSections(query);
  const phase = prismaInsightsSafeInteger(job.order_phase);
  const section = sections[phase];
  if (!section) {
    const state = readOrderState(job);
    const changed = await updatePrismaInsightsRows(
      client,
      provider,
      PRISMA_INSIGHTS_REPORT_JOBS,
      {
        phase: "seal",
        order_totals_json: canonicalInsightsJson({
          totals: state.totals,
          work: null,
          seal: {
            stage: "counts",
            afterCountKey: null,
            orderSection: 0,
            orderOrdinal: 0,
            countRows: 0,
            orderRows: 0,
            countDigest: emptySealDigest,
            countPeaks: [],
            orderDigest: emptySealDigest,
            seriesFirstBuckets: {},
          },
        }),
      },
      reportJobFence(job),
    );
    if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
    return 0;
  }
  const state = readOrderState(job);
  const work: OrderWork = state.work ?? {
    stage: "runs",
    kind: section.kind,
    metric: section.metric,
    afterKey: null,
    nextRun: 0,
    totalRows: 0,
  };
  if (work.kind !== section.kind || work.metric !== section.metric)
    throw new DatabasePluginInputError("invalid-result");

  if (work.stage === "runs") {
    const source = await selectPrismaInsightsRows<CountRow>(client, provider, {
      table:
        provider === "mysql"
          ? `${PRISMA_INSIGHTS_REPORT_COUNTS} force index (private_hot_updater_prisma_report_counts_source_idx)`
          : provider === "cockroachdb"
            ? `${PRISMA_INSIGHTS_REPORT_COUNTS}@private_hot_updater_prisma_report_counts_source_idx`
            : PRISMA_INSIGHTS_REPORT_COUNTS,
      columns: ["count_key", "label", "label_order", "value"],
      where: {
        job_id: job.id,
        section: section.kind,
        metric: section.metric,
        bucket_start_ms: -1,
        ...(work.afterKey === null
          ? {}
          : {
              count_key: {
                operator: "gt",
                value: Buffer.from(work.afterKey, "hex"),
              } as const,
            }),
      },
      orderBy: [{ column: "count_key", direction: "asc" }],
      limit: capacity,
    });
    const normalized = source.map((row) => {
      const expectedKey = countKey(section.kind, section.metric, row.label, -1);
      if (
        !Buffer.from(row.count_key).equals(expectedKey) ||
        !Buffer.from(row.label_order).equals(jsStringOrderKey(row.label))
      )
        throw new DatabasePluginInputError("invalid-result");
      return {
        countKey: Buffer.from(row.count_key),
        label: row.label,
        value: orderInteger(row.value),
      };
    });
    const bounded = boundedOrderRows(normalized, capacity);
    const lastCountKey = bounded.at(-1)?.countKey.toString("hex") ?? null;
    bounded.sort((left, right) =>
      compareOrderRows(section.byValue, left, right),
    );
    await insertSortRows(
      client,
      provider,
      job.id,
      section,
      0,
      work.nextRun,
      0,
      bounded,
    );
    const nextRun = work.nextRun + (bounded.length === 0 ? 0 : 1);
    const totalRows = work.totalRows + bounded.length;
    const exhausted =
      bounded.length === source.length && source.length < capacity;
    if (exhausted && nextRun === 0) {
      await completeOrderSection(
        client,
        provider,
        job,
        sections,
        phase,
        section,
        state,
        0,
      );
      return 0;
    }
    const nextWork: OrderWork = exhausted
      ? nextRun === 1
        ? {
            stage: "finalize",
            kind: section.kind,
            metric: section.metric,
            pass: 0,
            offset: 0,
            totalRows,
          }
        : {
            stage: "merge",
            kind: section.kind,
            metric: section.metric,
            pass: 0,
            run: 0,
            runCount: nextRun,
            leftOffset: 0,
            rightOffset: 0,
            outputOffset: 0,
            totalRows,
          }
      : {
          ...work,
          afterKey: lastCountKey ?? work.afterKey,
          nextRun,
          totalRows,
        };
    await saveOrderState(client, provider, job, {
      totals: state.totals,
      work: nextWork,
    });
    return bounded.length;
  }

  if (work.stage === "merge") {
    if (work.run >= work.runCount || work.run % 2 !== 0)
      throw new DatabasePluginInputError("invalid-result");
    const left = await readSortRun(
      client,
      provider,
      job.id,
      section,
      work.pass,
      work.run,
      work.leftOffset,
      capacity,
    );
    const hasRight = work.run + 1 < work.runCount;
    const right = hasRight
      ? await readSortRun(
          client,
          provider,
          job.id,
          section,
          work.pass,
          work.run + 1,
          work.rightOffset,
          capacity,
        )
      : [];
    if (
      getCanonicalInsightsJsonByteLength([...left, ...right]) >
      INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
    )
      throw new DatabasePluginInputError("invalid-result");
    let leftIndex = 0;
    let rightIndex = 0;
    const merged: MaterializedOrderRow[] = [];
    while (leftIndex < left.length || rightIndex < right.length) {
      const useLeft =
        rightIndex >= right.length ||
        (leftIndex < left.length &&
          compareOrderRows(
            section.byValue,
            left[leftIndex]!,
            right[rightIndex]!,
          ) <= 0);
      const candidate = useLeft ? left[leftIndex]! : right[rightIndex]!;
      if (
        boundedOrderRows([...merged, candidate], capacity).length <=
        merged.length
      )
        break;
      merged.push(candidate);
      if (useLeft) leftIndex += 1;
      else rightIndex += 1;
    }
    await insertSortRows(
      client,
      provider,
      job.id,
      section,
      work.pass + 1,
      Math.floor(work.run / 2),
      work.outputOffset,
      merged,
    );
    const leftOffset = work.leftOffset + leftIndex;
    const rightOffset = work.rightOffset + rightIndex;
    const outputOffset = work.outputOffset + merged.length;
    const leftExhausted = left.length < capacity && leftIndex === left.length;
    const rightExhausted =
      !hasRight || (right.length < capacity && rightIndex === right.length);
    let nextWork: OrderWork;
    if (leftExhausted && rightExhausted) {
      const nextRun = work.run + 2;
      if (nextRun < work.runCount) {
        nextWork = {
          ...work,
          run: nextRun,
          leftOffset: 0,
          rightOffset: 0,
          outputOffset: 0,
        };
      } else {
        const nextRunCount = Math.ceil(work.runCount / 2);
        nextWork =
          nextRunCount === 1
            ? {
                stage: "finalize",
                kind: section.kind,
                metric: section.metric,
                pass: work.pass + 1,
                offset: 0,
                totalRows: work.totalRows,
              }
            : {
                stage: "merge",
                kind: section.kind,
                metric: section.metric,
                pass: work.pass + 1,
                run: 0,
                runCount: nextRunCount,
                leftOffset: 0,
                rightOffset: 0,
                outputOffset: 0,
                totalRows: work.totalRows,
              };
      }
    } else {
      nextWork = {
        ...work,
        leftOffset,
        rightOffset,
        outputOffset,
      };
    }
    await saveOrderState(client, provider, job, {
      totals: state.totals,
      work: nextWork,
    });
    return merged.length;
  }

  if (work.stage === "finalize") {
    const source = await readSortRun(
      client,
      provider,
      job.id,
      section,
      work.pass,
      0,
      work.offset,
      capacity,
    );
    const rows = boundedOrderRows(source, capacity);
    await insertFinalOrderRows(
      client,
      provider,
      job.id,
      section,
      work.offset,
      rows,
    );
    const offset = work.offset + rows.length;
    if (rows.length < capacity) {
      if (offset !== work.totalRows)
        throw new DatabasePluginInputError("invalid-result");
      await saveOrderState(client, provider, job, {
        totals: state.totals,
        work: {
          stage: "cleanup",
          kind: section.kind,
          metric: section.metric,
          totalRows: work.totalRows,
        },
      });
    } else {
      await saveOrderState(client, provider, job, {
        totals: state.totals,
        work: { ...work, offset },
      });
    }
    return rows.length;
  }

  const keys = await selectPrismaInsightsRows<SortKeyRow>(client, provider, {
    table: PRISMA_INSIGHTS_REPORT_SORT,
    columns: ["sort_pass", "sort_run", "ordinal"],
    where: {
      job_id: job.id,
      order_kind: section.kind,
      metric: section.metric,
    },
    orderBy: [
      { column: "sort_pass", direction: "asc" },
      { column: "sort_run", direction: "asc" },
      { column: "ordinal", direction: "asc" },
    ],
    limit: capacity,
  });
  if (keys.length === 0) {
    await completeOrderSection(
      client,
      provider,
      job,
      sections,
      phase,
      section,
      state,
      work.totalRows,
    );
    return 0;
  }
  const sql = new PrismaInsightsSql(provider);
  const jobFilter = sql.value(job.id);
  const kindFilter = sql.value(section.kind);
  const metricFilter = sql.value(section.metric);
  const keyFilters = keys.map(
    (key) =>
      `(sort_pass=${sql.value(orderInteger(key.sort_pass))} and sort_run=${sql.value(
        orderInteger(key.sort_run),
      )} and ordinal=${sql.value(orderInteger(key.ordinal))})`,
  );
  const deleted = await executePrismaInsights(
    client,
    sql.statement(
      `delete from ${PRISMA_INSIGHTS_REPORT_SORT}
       where job_id=${jobFilter} and order_kind=${kindFilter}
         and metric=${metricFilter} and (${keyFilters.join(" or ")})`,
    ),
  );
  if (prismaInsightsSafeInteger(deleted) !== keys.length)
    throw new DatabasePluginInputError("invalid-result");
  await saveOrderState(client, provider, job, state);
  return keys.length;
};

const insertReportSeals = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  kind: "count" | "count-node" | "order",
  rows: readonly { readonly key: Buffer; readonly digest: Buffer }[],
): Promise<void> => {
  if (rows.length === 0) return;
  const sql = new PrismaInsightsSql(provider);
  const values = rows.map(
    ({ key, digest }) =>
      `(${sql.value(jobId)},${sql.value(kind)},${sql.value(key)},${sql.value(digest)})`,
  );
  const inserted = await executePrismaInsights(
    client,
    sql.statement(
      `insert into ${PRISMA_INSIGHTS_REPORT_SEALS}
       (job_id,seal_kind,seal_key,row_digest) values ${values.join(",")}`,
    ),
  );
  if (prismaInsightsSafeInteger(inserted) !== rows.length)
    throw new DatabasePluginInputError("invalid-result");
};

const saveSealState = (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  totals: Record<string, number>,
  seal: ReportSealState,
  phase: ReportPhase = "seal",
): Promise<void> =>
  saveOrderState(
    client,
    provider,
    job,
    { totals, work: null, seal },
    { phase },
  );

const processSeal = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  query: InsightsReportQuery,
  capacity: number,
): Promise<number> => {
  const state = readOrderState(job);
  const seal = state.seal;
  if (!seal || state.work !== null || seal.stage === "complete")
    throw new DatabasePluginInputError("invalid-result");

  if (seal.stage === "counts") {
    const rows = await selectPrismaInsightsRows<CountRow>(client, provider, {
      table: PRISMA_INSIGHTS_REPORT_COUNTS,
      columns: [
        "count_key",
        "section",
        "metric",
        "label",
        "label_order",
        "bucket_start_ms",
        "value",
      ],
      where: {
        job_id: job.id,
        ...(seal.afterCountKey === null
          ? {}
          : {
              count_key: {
                operator: "gt",
                value: Buffer.from(seal.afterCountKey, "hex"),
              } as const,
            }),
      },
      orderBy: [{ column: "count_key", direction: "asc" }],
      limit: capacity,
    });
    let digest = seal.countDigest;
    let countPeaks = seal.countPeaks;
    const countNodes: { key: Buffer; digest: Buffer }[] = [];
    const seriesFirstBuckets = { ...seal.seriesFirstBuckets };
    const sealed = rows.map((row, index) => {
      const bucketStartMs = signedSafeInteger(row.bucket_start_ms);
      const value = orderInteger(row.value);
      const key = Buffer.from(row.count_key);
      if (
        !key.equals(
          countKey(row.section, row.metric, row.label, bucketStartMs),
        ) ||
        !Buffer.from(row.label_order).equals(jsStringOrderKey(row.label))
      )
        throw new DatabasePluginInputError("invalid-result");
      const rowDigest = reportRowDigest("count", [
        row.section,
        row.metric,
        row.label,
        bucketStartMs,
        value,
      ]);
      const ordinal = seal.countRows + index;
      const leafDigest = countLeafDigest(ordinal, key, rowDigest);
      const appended = appendCountPeak(countPeaks, ordinal, leafDigest);
      countPeaks = appended.peaks;
      countNodes.push(...appended.nodes);
      if (row.section === "movementSeries" || row.section === "activeSeries") {
        const seriesKey = seriesFirstBucketKey(row.section, row.metric);
        const current = seriesFirstBuckets[seriesKey];
        if (current === undefined || bucketStartMs < current)
          seriesFirstBuckets[seriesKey] = bucketStartMs;
      }
      digest = nextSealDigest(digest, rowDigest);
      return { key, digest: encodeCountLeafSeal(ordinal, leafDigest) };
    });
    await insertReportSeals(client, provider, job.id, "count", sealed);
    await insertReportSeals(client, provider, job.id, "count-node", countNodes);
    const exhausted = rows.length < capacity;
    await saveSealState(client, provider, job, state.totals, {
      ...seal,
      stage: exhausted ? "order" : "counts",
      afterCountKey:
        rows.at(-1) === undefined
          ? seal.afterCountKey
          : Buffer.from(rows.at(-1)!.count_key).toString("hex"),
      countRows: seal.countRows + rows.length,
      countDigest: digest,
      countPeaks,
      seriesFirstBuckets,
    });
    return rows.length;
  }

  const sections = orderSections(query);
  const section = sections[seal.orderSection];
  if (!section) {
    const expectedOrderRows = Object.values(state.totals).reduce(
      (total, value) => total + value,
      0,
    );
    if (seal.orderRows !== expectedOrderRows)
      throw new DatabasePluginInputError("invalid-result");
    await saveSealState(
      client,
      provider,
      job,
      state.totals,
      { ...seal, stage: "complete" },
      "publish",
    );
    return 0;
  }
  const total = state.totals[orderTotalKey(section.kind, section.metric)];
  if (total === undefined || seal.orderOrdinal > total)
    throw new DatabasePluginInputError("invalid-result");
  if (seal.orderOrdinal === total) {
    await saveSealState(client, provider, job, state.totals, {
      ...seal,
      orderSection: seal.orderSection + 1,
      orderOrdinal: 0,
    });
    return 0;
  }
  const size = Math.min(capacity, total - seal.orderOrdinal);
  const rows = await selectPrismaInsightsRows<OrderRow>(client, provider, {
    table: PRISMA_INSIGHTS_REPORT_ORDER,
    columns: ["ordinal", "label", "value"],
    where: {
      job_id: job.id,
      order_kind: section.kind,
      metric: section.metric,
      ordinal: { operator: "gte", value: seal.orderOrdinal },
    },
    orderBy: [{ column: "ordinal", direction: "asc" }],
    limit: size,
  });
  if (rows.length !== size)
    throw new DatabasePluginInputError("invalid-result");
  let digest = seal.orderDigest;
  const sealed = rows.map((row, index) => {
    const ordinal = orderInteger(row.ordinal);
    const value = orderInteger(row.value);
    if (ordinal !== seal.orderOrdinal + index)
      throw new DatabasePluginInputError("invalid-result");
    const rowDigest = reportRowDigest("order", [
      section.kind,
      section.metric,
      ordinal,
      row.label,
      value,
    ]);
    digest = nextSealDigest(digest, rowDigest);
    return {
      key: orderSealKey(section.kind, section.metric, ordinal),
      digest: rowDigest,
    };
  });
  await insertReportSeals(client, provider, job.id, "order", sealed);
  await saveSealState(client, provider, job, state.totals, {
    ...seal,
    orderOrdinal: seal.orderOrdinal + rows.length,
    orderRows: seal.orderRows + rows.length,
    orderDigest: digest,
  });
  return rows.length;
};

const publish = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  query: InsightsReportQuery,
): Promise<void> => {
  const orderState = readOrderState(job);
  const seal = orderState.seal;
  if (!seal || seal.stage !== "complete" || orderState.work !== null)
    throw new DatabasePluginInputError("invalid-result");
  const expectedOrderRows = Object.values(orderState.totals).reduce(
    (total, value) => total + value,
    0,
  );
  if (seal.orderRows !== expectedOrderRows)
    throw new DatabasePluginInputError("invalid-result");
  const remainingSort = await selectPrismaInsightsRows<SortKeyRow>(
    client,
    provider,
    {
      table: PRISMA_INSIGHTS_REPORT_SORT,
      columns: ["sort_pass", "sort_run", "ordinal"],
      where: { job_id: job.id },
      limit: 1,
    },
  );
  if (remainingSort.length !== 0)
    throw new DatabasePluginInputError("invalid-result");
  const requestedKeys = summaryCountIdentities(query);
  const counts = await readCountsByKeys(
    client,
    provider,
    job.id,
    {
      countRows: seal.countRows,
      countPeaks: seal.countPeaks,
      countRoot: countCommitmentRoot(seal.countRows, seal.countPeaks),
    },
    requestedKeys,
  );
  const value = (
    section: string,
    metric: string,
    label: string,
    bucketStartMs: number,
  ): number => {
    const key = countKey(section, metric, label, bucketStartMs);
    return counts.get(key.toString("hex")) ?? 0;
  };
  const completedAtMs = await readPrismaInsightsDatabaseTime(client, provider);
  const base = prismaInsightsPublication({
    id: job.id,
    asOfMs: prismaInsightsSafeInteger(job.as_of_ms),
    completedAtMs,
    sourceGeneration: prismaInsightsSafeInteger(job.source_generation),
  });
  let publication: InsightsReportPublication;
  switch (query.kind) {
    case "bundleSummaries":
      publication = {
        ...base,
        kind: query.kind,
        summary: query.bundleIds.map((bundleId) => ({
          bundleId,
          installed: value("summary", "installed", bundleId, -1),
          recovered: value("summary", "recovered", bundleId, -1),
        })),
      };
      break;
    case "bundleDetail":
      publication = {
        ...base,
        kind: query.kind,
        summary: {
          installed: value("summary", "installed", query.bundleId, -1),
          recovered: value("summary", "recovered", query.bundleId, -1),
        },
      };
      break;
    case "installationOverview":
      publication = {
        ...base,
        kind: query.kind,
        summary: { trackedInstallations: value("summary", "", "", -1) },
      };
      break;
    case "activeOverview":
      publication = {
        ...base,
        kind: query.kind,
        summary: { activeInstallations: value("summary", "", "", -1) },
      };
      break;
  }
  const publicationJson = canonicalInsightsJson(publication);
  const manifest: ReportManifest = {
    revision: 3,
    countRows: seal.countRows,
    countPeaks: seal.countPeaks,
    countRoot: countCommitmentRoot(seal.countRows, seal.countPeaks),
    orderRows: seal.orderRows,
    countDigest: seal.countDigest,
    orderDigest: seal.orderDigest,
    orderTotals: orderState.totals,
    publicationDigest: prismaInsightsDigest([
      "prisma-report-publication-v1",
      publicationJson,
    ]).toString("hex"),
    seriesFirstBuckets: seal.seriesFirstBuckets,
  };
  const manifestJson = canonicalInsightsJson(manifest);
  const manifestDigest = prismaInsightsDigest([
    "prisma-report-manifest-v3",
    job.query_json,
    prismaInsightsSafeInteger(job.source_generation),
    prismaInsightsSafeInteger(job.as_of_ms),
    manifestJson,
  ]);
  const changed = await updatePrismaInsightsRows(
    client,
    provider,
    PRISMA_INSIGHTS_REPORT_JOBS,
    {
      state: "ready",
      completed_at_ms: completedAtMs,
      publication_json: publicationJson,
      manifest_json: manifestJson,
      manifest_digest: manifestDigest,
    },
    { ...reportJobFence(job), state: "preparing" },
  );
  if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
  const headChanged = await updatePrismaInsightsRows(
    client,
    provider,
    PRISMA_INSIGHTS_REPORT_HEADS,
    { active_job_id: null, publication_job_id: job.id },
    { query_key: Buffer.from(job.query_key), active_job_id: job.id },
  );
  if (headChanged !== 1) throw new DatabasePluginInputError("invalid-result");
};

export interface PrismaInsightsReportStepInput {
  readonly maxItems: number;
  readonly maxRequests: number;
  readonly jobId?: string;
}

export const runPrismaInsightsReportStep = (
  client: PrismaInsightsClient,
  provider: ORMSQLProvider,
  input: PrismaInsightsReportStepInput,
): Promise<{ readonly processed: number; readonly jobId: string | null }> => {
  if (
    !Number.isSafeInteger(input.maxItems) ||
    input.maxItems < 1 ||
    input.maxItems > INSIGHTS_MAINTENANCE_MAX_ITEMS ||
    !Number.isSafeInteger(input.maxRequests) ||
    input.maxRequests < 1 ||
    input.maxRequests > INSIGHTS_MAINTENANCE_MAX_REQUESTS ||
    (input.jobId !== undefined &&
      (typeof input.jobId !== "string" || input.jobId.length === 0))
  )
    throw new DatabasePluginInputError("invalid-query");
  if (input.maxRequests < 8)
    return Promise.resolve({ processed: 0, jobId: null });
  const maxItems = Math.min(200, input.maxItems);
  return runPrismaInsightsTransaction(client, provider, async (transaction) => {
    const queued = await selectPrismaInsightsRows<ReportJob>(
      transaction,
      provider,
      {
        table: PRISMA_INSIGHTS_REPORT_JOBS,
        columns: jobColumns,
        where: {
          state: "queued",
          ...(input.jobId === undefined ? {} : { id: input.jobId }),
        },
        orderBy: [{ column: "id", direction: "asc" }],
        limit: 1,
        lock: "skip-locked",
      },
    );
    const selected =
      queued[0] ??
      (
        await selectPrismaInsightsRows<ReportJob>(transaction, provider, {
          table: PRISMA_INSIGHTS_REPORT_JOBS,
          columns: jobColumns,
          where: {
            state: "preparing",
            ...(input.jobId === undefined ? {} : { id: input.jobId }),
          },
          orderBy: [{ column: "id", direction: "asc" }],
          limit: 1,
          lock: "skip-locked",
        })
      )[0];
    if (!selected) return { processed: 0, jobId: null };
    const leaseVersion = prismaInsightsSafeInteger(selected.lease_version);
    const leaseOwner = newPrismaInsightsId();
    const claimed = await updatePrismaInsightsRows(
      transaction,
      provider,
      PRISMA_INSIGHTS_REPORT_JOBS,
      {
        state: "preparing",
        lease_owner: leaseOwner,
        lease_version: leaseVersion + 1,
      },
      {
        id: selected.id,
        state: selected.state,
        lease_version: leaseVersion,
      },
    );
    if (claimed !== 1) return { processed: 0, jobId: null };
    const job: ReportJob = {
      ...selected,
      state: "preparing",
      lease_owner: leaseOwner,
      lease_version: leaseVersion + 1,
    };
    try {
      const query = parseQuery(job);
      let processed = 0;
      switch (job.phase) {
        case "source": {
          const capacity = Math.min(
            maxItems,
            Math.floor((input.maxRequests - 6) / 6),
          );
          if (capacity > 0)
            processed = await processSource(
              transaction,
              provider,
              job,
              query,
              capacity,
            );
          break;
        }
        case "members": {
          const capacity = Math.min(
            maxItems,
            Math.floor(
              (input.maxRequests - 6) / (provider === "mysql" ? 3 : 2),
            ),
          );
          if (capacity > 0)
            processed = await processMembers(
              transaction,
              provider,
              job,
              capacity,
            );
          break;
        }
        case "installations":
          if (
            query.kind !== "installationOverview" &&
            query.kind !== "activeOverview"
          )
            throw new DatabasePluginInputError("invalid-result");
          processed = await processInstallations(
            transaction,
            provider,
            job,
            query,
            maxItems,
            input.maxRequests,
          );
          break;
        case "order":
          processed = await processOrder(
            transaction,
            provider,
            job,
            query,
            maxItems,
          );
          break;
        case "seal":
          processed = await processSeal(
            transaction,
            provider,
            job,
            query,
            maxItems,
          );
          break;
        case "publish":
          await publish(transaction, provider, job, query);
          break;
      }
      return { processed, jobId: job.id };
    } catch (error) {
      if (!(error instanceof DatabasePluginInputError)) throw error;
      const failed = await updatePrismaInsightsRows(
        transaction,
        provider,
        PRISMA_INSIGHTS_REPORT_JOBS,
        {
          state: "failed",
          failure_json: canonicalInsightsJson({
            code:
              error instanceof PrismaInsightsReportPoisonError
                ? "migration-poison"
                : "preparation-failed",
          }),
        },
        reportJobFence(job),
      );
      if (failed !== 1) throw error;
      return { processed: 0, jobId: job.id };
    }
  });
};

const requireSection = (
  query: InsightsReportQuery,
  request: ReturnType<typeof readInsightsReportPageQuery>["input"],
): void => {
  if (
    (request.section === "movementSeries" ||
      request.section === "movementCohorts") &&
    query.kind !== "bundleDetail"
  )
    throw new DatabasePluginInputError("invalid-query");
  if (
    request.section === "bundleDistribution" &&
    query.kind !== "installationOverview" &&
    query.kind !== "activeOverview"
  )
    throw new DatabasePluginInputError("invalid-query");
  if (
    (request.section === "activeSeries" ||
      request.section === "activeBundleSeries") &&
    query.kind !== "activeOverview"
  )
    throw new DatabasePluginInputError("invalid-query");
};

const preflightReportPage = (
  input: InsightsReportPageInput,
): {
  readonly input: InsightsReportPageInput;
  readonly claimedNamespace: string | null;
  readonly parsed: ReturnType<typeof readInsightsReportPageQuery> | null;
} => {
  const canonical = readInsightsReportPageInput(input);
  if (canonical.cursor === undefined) {
    return { input: canonical, claimedNamespace: null, parsed: null };
  }
  const envelope = JSON.parse(canonical.cursor) as [1, string, string];
  const semantic = JSON.parse(envelope[1]) as readonly unknown[];
  const claimedNamespace = semantic[0];
  if (typeof claimedNamespace !== "string")
    throw new DatabasePluginInputError("invalid-query");
  return {
    input: canonical,
    claimedNamespace,
    parsed: readInsightsReportPageQuery(canonical, claimedNamespace),
  };
};

const pageBounds = (
  input: InsightsReportPageInput,
  start: bigint,
  total: bigint,
  sourceId: string,
) => {
  const available = total > start ? total - start : 0n;
  const size = Number(
    available < BigInt(input.limit) ? available : BigInt(input.limit),
  );
  const next = start + BigInt(size);
  return {
    size,
    nextCursor:
      next < total
        ? createInsightsReportPageCursor(input, next.toString(), sourceId)
        : null,
  };
};

const readSealsByKeys = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  kind: "count" | "count-node" | "order",
  keys: readonly Buffer[],
): Promise<Map<string, Buffer>> => {
  if (keys.length === 0) return new Map();
  const sql = new PrismaInsightsSql(provider);
  const rows = await queryPrismaInsights<SealRow[]>(
    client,
    sql.statement(
      `select seal_kind,seal_key,row_digest from ${PRISMA_INSIGHTS_REPORT_SEALS}
       where job_id=${sql.value(jobId)} and seal_kind=${sql.value(kind)}
         and seal_key in (${keys.map((key) => sql.value(key)).join(",")})`,
    ),
  );
  const requested = new Set(keys.map((key) => key.toString("hex")));
  const result = new Map<string, Buffer>();
  for (const row of rows) {
    const key = Buffer.from(row.seal_key).toString("hex");
    if (
      row.seal_kind !== kind ||
      !requested.has(key) ||
      result.has(key) ||
      Buffer.from(row.row_digest).length !== (kind === "count" ? 40 : 32)
    )
      throw new DatabasePluginInputError("invalid-result");
    result.set(key, Buffer.from(row.row_digest));
  }
  return result;
};

const readCountSealNeighbors = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  keys: readonly Buffer[],
): Promise<Map<string, Buffer>> => {
  if (keys.length === 0) return new Map();
  const sql = new PrismaInsightsSql(provider);
  const outerJob = sql.value(jobId);
  const outerKind = sql.value("count");
  const neighbor = (key: Buffer, direction: "before" | "after") => {
    const comparison = direction === "before" ? "<" : ">";
    const order = direction === "before" ? "desc" : "asc";
    return provider === "mssql"
      ? `(select top (1) seal_key from ${PRISMA_INSIGHTS_REPORT_SEALS}
          where job_id=${sql.value(jobId)} and seal_kind=${sql.value("count")}
            and seal_key${comparison}${sql.value(key)} order by seal_key ${order})`
      : `(select seal_key from ${PRISMA_INSIGHTS_REPORT_SEALS}
          where job_id=${sql.value(jobId)} and seal_kind=${sql.value("count")}
            and seal_key${comparison}${sql.value(key)} order by seal_key ${order} limit 1)`;
  };
  const neighbors = keys.flatMap((key) => [
    neighbor(key, "before"),
    neighbor(key, "after"),
  ]);
  const rows = await queryPrismaInsights<SealRow[]>(
    client,
    sql.statement(
      `select seal_kind,seal_key,row_digest
       from ${PRISMA_INSIGHTS_REPORT_SEALS}
       where job_id=${outerJob} and seal_kind=${outerKind}
         and seal_key in (${neighbors.join(",")})`,
    ),
  );
  const result = new Map<string, Buffer>();
  for (const row of rows) {
    const key = Buffer.from(row.seal_key).toString("hex");
    if (
      row.seal_kind !== "count" ||
      result.has(key) ||
      Buffer.from(row.row_digest).length !== 40
    )
      throw new DatabasePluginInputError("invalid-result");
    result.set(key, Buffer.from(row.row_digest));
  }
  return result;
};

const countPeakForOrdinal = (
  commitment: CountCommitment,
  ordinal: number,
): { readonly level: number; readonly digest: Buffer } => {
  if (ordinal < 0 || ordinal >= commitment.countRows)
    throw new DatabasePluginInputError("invalid-result");
  let start = 0n;
  const target = BigInt(ordinal);
  for (let level = commitment.countPeaks.length - 1; level >= 0; level -= 1) {
    const peak = commitment.countPeaks[level];
    if (peak === null || peak === undefined) continue;
    const size = 1n << BigInt(level);
    if (target < start + size)
      return { level, digest: Buffer.from(peak, "hex") };
    start += size;
  }
  throw new DatabasePluginInputError("invalid-result");
};

const verifyCountLeafSeals = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  commitment: CountCommitment,
  leaves: ReadonlyMap<string, Buffer>,
): Promise<Map<string, ReturnType<typeof readCountLeafSeal>>> => {
  if (
    countCommitmentRoot(commitment.countRows, commitment.countPeaks) !==
    commitment.countRoot
  )
    throw new DatabasePluginInputError("invalid-result");
  const parsed = new Map<string, ReturnType<typeof readCountLeafSeal>>();
  const nodeKeys = new Map<string, Buffer>();
  for (const [key, encoded] of leaves) {
    const leaf = readCountLeafSeal(encoded);
    const peak = countPeakForOrdinal(commitment, leaf.ordinal);
    parsed.set(key, leaf);
    const self = countNodeKey(0, leaf.ordinal);
    nodeKeys.set(self.toString("hex"), self);
    for (let level = 0; level < peak.level; level += 1) {
      const siblingOrdinal = Math.floor(leaf.ordinal / 2 ** level) ^ 1;
      const sibling = countNodeKey(level, siblingOrdinal);
      nodeKeys.set(sibling.toString("hex"), sibling);
    }
  }
  const nodes = new Map<string, Buffer>();
  const allNodeKeys = [...nodeKeys.values()];
  for (let offset = 0; offset < allNodeKeys.length; offset += 400) {
    const page = await readSealsByKeys(
      client,
      provider,
      jobId,
      "count-node",
      allNodeKeys.slice(offset, offset + 400),
    );
    for (const [key, digest] of page) nodes.set(key, digest);
  }
  if (nodes.size !== nodeKeys.size)
    throw new DatabasePluginInputError("invalid-result");
  for (const [key, leaf] of parsed) {
    const peak = countPeakForOrdinal(commitment, leaf.ordinal);
    if (
      !nodes
        .get(countNodeKey(0, leaf.ordinal).toString("hex"))
        ?.equals(leaf.digest)
    )
      throw new DatabasePluginInputError("invalid-result");
    let digest = leaf.digest;
    for (let level = 0; level < peak.level; level += 1) {
      const siblingOrdinal = Math.floor(leaf.ordinal / 2 ** level) ^ 1;
      const sibling = nodes.get(
        countNodeKey(level, siblingOrdinal).toString("hex"),
      );
      if (!sibling) throw new DatabasePluginInputError("invalid-result");
      const parentLevel = level + 1;
      const parentOrdinal = Math.floor(leaf.ordinal / 2 ** parentLevel);
      digest =
        Math.floor(leaf.ordinal / 2 ** level) % 2 === 0
          ? countParentDigest(parentLevel, parentOrdinal, digest, sibling)
          : countParentDigest(parentLevel, parentOrdinal, sibling, digest);
    }
    if (!digest.equals(peak.digest) || !leaves.has(key))
      throw new DatabasePluginInputError("invalid-result");
  }
  return parsed;
};

const readCountsByKeys = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  jobId: string,
  commitment: CountCommitment,
  identities: readonly CountIdentity[],
): Promise<Map<string, number>> => {
  if (identities.length === 0) return new Map();
  const sql = new PrismaInsightsSql(provider);
  const job = sql.value(jobId);
  const markers = identities.map(({ key }) => sql.value(key));
  const rows = await queryPrismaInsights<CountRow[]>(
    client,
    sql.statement(
      `select count_key,section,metric,label,label_order,bucket_start_ms,value
       from ${PRISMA_INSIGHTS_REPORT_COUNTS}
       where job_id=${job} and count_key in (${markers.join(",")})`,
    ),
  );
  const expected = new Map(
    identities.map((identity) => [identity.key.toString("hex"), identity]),
  );
  const seals = await readSealsByKeys(
    client,
    provider,
    jobId,
    "count",
    identities.map(({ key }) => key),
  );
  const neighbors = await readCountSealNeighbors(
    client,
    provider,
    jobId,
    identities.map(({ key }) => key),
  );
  const allLeaves = new Map([...seals, ...neighbors]);
  const parsedLeaves = await verifyCountLeafSeals(
    client,
    provider,
    jobId,
    commitment,
    allLeaves,
  );
  for (const row of rows) {
    const key = Buffer.from(row.count_key).toString("hex");
    const identity = expected.get(key);
    const bucketStartMs = signedSafeInteger(row.bucket_start_ms);
    const value = prismaInsightsSafeInteger(row.value);
    if (
      !identity ||
      row.section !== identity.section ||
      row.metric !== identity.metric ||
      row.label !== identity.label ||
      bucketStartMs !== identity.bucketStartMs ||
      !Buffer.from(row.label_order).equals(jsStringOrderKey(row.label)) ||
      !parsedLeaves
        .get(key)
        ?.digest.equals(
          countLeafDigest(
            parsedLeaves.get(key)!.ordinal,
            row.count_key,
            reportRowDigest("count", [
              row.section,
              row.metric,
              row.label,
              bucketStartMs,
              value,
            ]),
          ),
        )
    )
      throw new DatabasePluginInputError("invalid-result");
  }
  const present = new Set(
    rows.map((row) => Buffer.from(row.count_key).toString("hex")),
  );
  if ([...seals.keys()].some((key) => !present.has(key)))
    throw new DatabasePluginInputError("invalid-result");
  const orderedLeaves = [...parsedLeaves.entries()].toSorted(
    ([left], [right]) =>
      Buffer.compare(Buffer.from(left, "hex"), Buffer.from(right, "hex")),
  );
  for (const identity of expected.values()) {
    const key = identity.key.toString("hex");
    if (present.has(key)) continue;
    const insertion = orderedLeaves.findIndex(([candidate]) => candidate > key);
    const before =
      insertion === -1
        ? orderedLeaves.at(-1)
        : insertion === 0
          ? undefined
          : orderedLeaves[insertion - 1];
    const after = insertion === -1 ? undefined : orderedLeaves[insertion];
    if (
      (before === undefined &&
        after === undefined &&
        commitment.countRows !== 0) ||
      (before === undefined && after !== undefined && after[1].ordinal !== 0) ||
      (after === undefined &&
        before !== undefined &&
        before[1].ordinal !== commitment.countRows - 1) ||
      (before !== undefined &&
        after !== undefined &&
        after[1].ordinal !== before[1].ordinal + 1)
    )
      throw new DatabasePluginInputError("invalid-result");
  }
  return new Map(
    rows.map((row) => [
      Buffer.from(row.count_key).toString("hex"),
      prismaInsightsSafeInteger(row.value),
    ]),
  );
};

const verifyPublishedSummary = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  query: InsightsReportQuery,
  publication: InsightsReportPublication,
  manifest: ReportManifest,
): Promise<void> => {
  const identities = summaryCountIdentities(query);
  const counts = await readCountsByKeys(
    client,
    provider,
    job.id,
    manifest,
    identities,
  );
  const value = (identity: CountIdentity): number =>
    counts.get(identity.key.toString("hex")) ?? 0;
  let expected: unknown;
  switch (query.kind) {
    case "bundleSummaries":
      expected = query.bundleIds.map((bundleId, index) => ({
        bundleId,
        installed: value(identities[index * 2]!),
        recovered: value(identities[index * 2 + 1]!),
      }));
      break;
    case "bundleDetail":
      expected = {
        installed: value(identities[0]!),
        recovered: value(identities[1]!),
      };
      break;
    case "installationOverview":
      expected = { trackedInstallations: value(identities[0]!) };
      break;
    case "activeOverview":
      expected = { activeInstallations: value(identities[0]!) };
      break;
  }
  if (
    canonicalInsightsJson(Reflect.get(publication, "summary")) !==
    canonicalInsightsJson(expected)
  )
    throw new DatabasePluginInputError("invalid-result");
};

const readOrderedPage = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  manifest: ReportManifest,
  input: InsightsReportPageInput,
  kind: string,
  metric: string,
  start: bigint,
  sourceId: string,
) => {
  const totalValue = manifest.orderTotals[orderTotalKey(kind, metric)];
  if (totalValue === undefined)
    throw new DatabasePluginInputError("invalid-result");
  const total = BigInt(totalValue);
  const bounds = pageBounds(input, start, total, sourceId);
  const rows =
    bounds.size === 0
      ? []
      : await selectPrismaInsightsRows<OrderRow>(client, provider, {
          table: PRISMA_INSIGHTS_REPORT_ORDER,
          columns: ["ordinal", "label", "value"],
          where: {
            job_id: job.id,
            order_kind: kind,
            metric,
            ordinal: { operator: "gte", value: exactNumber(start) },
          },
          orderBy: [{ column: "ordinal", direction: "asc" }],
          limit: bounds.size,
        });
  if (rows.length !== bounds.size)
    throw new DatabasePluginInputError("invalid-result");
  const startOrdinal = exactNumber(start);
  const keys = rows.map((row, index) => {
    const ordinal = orderInteger(row.ordinal);
    if (ordinal !== startOrdinal + index)
      throw new DatabasePluginInputError("invalid-result");
    return orderSealKey(kind, metric, ordinal);
  });
  const seals = await readSealsByKeys(client, provider, job.id, "order", keys);
  if (
    rows.some((row, index) => {
      const key = keys[index]!.toString("hex");
      return !seals
        .get(key)
        ?.equals(
          reportRowDigest("order", [
            kind,
            metric,
            orderInteger(row.ordinal),
            row.label,
            orderInteger(row.value),
          ]),
        );
    })
  )
    throw new DatabasePluginInputError("invalid-result");
  const overflow = await selectPrismaInsightsRows<OrderRow>(client, provider, {
    table: PRISMA_INSIGHTS_REPORT_ORDER,
    columns: ["ordinal", "label", "value"],
    where: {
      job_id: job.id,
      order_kind: kind,
      metric,
      ordinal: { operator: "gte", value: totalValue },
    },
    orderBy: [{ column: "ordinal", direction: "asc" }],
    limit: 1,
  });
  if (overflow.length !== 0)
    throw new DatabasePluginInputError("invalid-result");
  return { rows, total, nextCursor: bounds.nextCursor };
};

const failReadyReportStorage = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  job: ReportJob,
  requestedLimit: number,
): Promise<InsightsReportPage> => {
  const changed = await updatePrismaInsightsRows(
    client,
    provider,
    PRISMA_INSIGHTS_REPORT_JOBS,
    {
      state: "failed",
      failure_json: canonicalInsightsJson({ code: "storage-corruption" }),
      lease_owner: null,
    },
    { id: job.id, state: "ready" },
  );
  if (changed !== 1) throw new DatabasePluginInputError("invalid-result");
  return validatedReportPage(
    {
      state: "failed",
      versions: versions(job),
      error: { code: "storage-corruption" },
    },
    requestedLimit,
  );
};

export const pagePrismaInsightsReport = async (
  client: PrismaInsightsClient,
  provider: ORMSQLProvider,
  databaseNamespace: string,
  input: InsightsReportPageInput,
): Promise<InsightsReportPage> => {
  const preflight = preflightReportPage(input);
  input = preflight.input;
  return runPrismaInsightsTransaction(client, provider, async (transaction) => {
    const source = await readPrismaInsightsState(
      transaction,
      databaseNamespace,
    );
    if (
      preflight.claimedNamespace !== null &&
      preflight.claimedNamespace !== source.sourceId
    )
      throw new DatabasePluginInputError("invalid-query");
    const parsed =
      preflight.parsed ?? readInsightsReportPageQuery(input, source.sourceId);
    const job = await readJob(transaction, provider, input.publicationId);
    if (!job)
      return validatedReportPage(
        { state: "expired", publicationId: input.publicationId },
        input.limit,
      );
    if (job.state !== "ready") {
      const failure = reportFailureCode(job);
      return validatedReportPage(
        {
          state: "failed",
          versions: versions(job),
          error: {
            code:
              failure === "storage-corruption"
                ? "storage-corruption"
                : "index-not-ready",
          },
        },
        input.limit,
      );
    }
    try {
      const query = parseQuery(job);
      requireSection(query, parsed.input);
      const reportPublication = readPublication(job);
      const manifest = readReportManifest(job);
      const publication = {
        id: reportPublication.id,
        asOfMs: reportPublication.asOfMs,
        completedAtMs: reportPublication.completedAtMs,
        sourceGeneration: reportPublication.sourceGeneration,
        accuracy: reportPublication.accuracy,
      } as const;
      const consistency = {
        kind: "snapshot" as const,
        cutoff: { kind: "publication" as const, publication },
      };
      const sourceGeneration = publication.sourceGeneration;
      const start = BigInt(parsed.nextOrdinal);
      const projection = createInsightsReportProjection(
        query,
        prismaInsightsSafeInteger(job.as_of_ms),
      );
      let data: InsightsPublishedReportPageData;
      if (
        parsed.input.section === "movementCohorts" ||
        parsed.input.section === "bundleDistribution"
      ) {
        const metric =
          parsed.input.section === "movementCohorts" ? parsed.input.metric : "";
        const page = await readOrderedPage(
          transaction,
          provider,
          job,
          manifest,
          input,
          parsed.input.section,
          metric,
          start,
          source.sourceId,
        );
        const common = {
          nextCursor: page.nextCursor,
          hasNext: page.nextCursor !== null,
          consistency,
          total: {
            state: "exact" as const,
            value: exactNumber(page.total),
            sourceGeneration,
          },
        };
        data =
          parsed.input.section === "movementCohorts"
            ? {
                ...common,
                section: parsed.input.section,
                metric: parsed.input.metric,
                data: page.rows.map((row) => ({
                  cohort: row.label,
                  value: prismaInsightsSafeInteger(row.value),
                })),
              }
            : {
                ...common,
                section: parsed.input.section,
                data: page.rows.map((row) => ({
                  bundleId: row.label,
                  installations: prismaInsightsSafeInteger(row.value),
                })),
              };
      } else if (
        parsed.input.section === "movementSeries" ||
        parsed.input.section === "activeSeries"
      ) {
        let first = projection.firstBucketMs;
        if (first === null) {
          first =
            manifest.seriesFirstBuckets[
              seriesFirstBucketKey(
                parsed.input.section,
                parsed.input.section === "movementSeries"
                  ? parsed.input.metric
                  : "",
              )
            ] ?? projection.lastBucketMs;
        }
        const total =
          first > projection.lastBucketMs
            ? 0n
            : BigInt(
                Math.floor(
                  (projection.lastBucketMs - first) / projection.bucketSizeMs,
                ) + 1,
              );
        const bounds = pageBounds(input, start, total, source.sourceId);
        const buckets = Array.from({ length: bounds.size }, (_, index) =>
          exactNumber(
            BigInt(first!) +
              (start + BigInt(index)) * BigInt(projection.bucketSizeMs),
          ),
        );
        const label =
          parsed.input.section === "movementSeries" &&
          query.kind === "bundleDetail"
            ? query.bundleId
            : "";
        const metric =
          parsed.input.section === "movementSeries" ? parsed.input.metric : "";
        const keys = buckets.map((bucket) =>
          countIdentity(parsed.input.section, metric, label, bucket),
        );
        const counts = await readCountsByKeys(
          transaction,
          provider,
          job.id,
          manifest,
          keys,
        );
        const common = {
          data: buckets.map((bucketStartMs, index) => ({
            bucketStartMs,
            value: counts.get(keys[index]!.key.toString("hex")) ?? 0,
          })),
          nextCursor: bounds.nextCursor,
          hasNext: bounds.nextCursor !== null,
          consistency,
          total: {
            state: "exact" as const,
            value: exactNumber(total),
            sourceGeneration,
          },
        };
        data =
          parsed.input.section === "movementSeries"
            ? {
                ...common,
                section: parsed.input.section,
                metric: parsed.input.metric,
              }
            : { ...common, section: parsed.input.section };
      } else {
        const first = projection.firstBucketMs!;
        const bucketCount = BigInt(
          Math.floor(
            (projection.lastBucketMs - first) / projection.bucketSizeMs,
          ) + 1,
        );
        let bundles: readonly OrderRow[];
        let total: bigint;
        if ("bundleId" in parsed.input && parsed.input.bundleId !== undefined) {
          const key = countIdentity(
            "activeBundleTotals",
            "",
            parsed.input.bundleId,
            -1,
          );
          const counts = await readCountsByKeys(
            transaction,
            provider,
            job.id,
            manifest,
            [key],
          );
          const observations = counts.get(key.key.toString("hex")) ?? 0;
          bundles = [
            {
              ordinal: 0,
              label: parsed.input.bundleId,
              value: observations,
            },
          ];
          total = observations === 0 ? 0n : bucketCount;
        } else {
          const page = await readOrderedPage(
            transaction,
            provider,
            job,
            manifest,
            input,
            "activeBundleTotals",
            "",
            start / bucketCount,
            source.sourceId,
          );
          const bundleTotal = page.total;
          total = bundleTotal * bucketCount;
          const firstRank = start / bucketCount;
          const available = total > start ? total - start : 0n;
          const pageSize =
            available < BigInt(input.limit) ? available : BigInt(input.limit);
          const needed =
            pageSize === 0n
              ? 0
              : exactNumber(
                  (start + pageSize - 1n) / bucketCount - firstRank + 1n,
                );
          bundles = page.rows.slice(0, needed);
        }
        const bounds = pageBounds(input, start, total, source.sourceId);
        const baseRank = start / bucketCount;
        const positions = Array.from({ length: bounds.size }, (_, index) => {
          const ordinal = start + BigInt(index);
          const rank = ordinal / bucketCount;
          const bundle =
            ("bundleId" in parsed.input ? parsed.input.bundleId : undefined) ??
            bundles[Number(rank - baseRank)]?.label;
          if (bundle === undefined)
            throw new DatabasePluginInputError("invalid-result");
          return {
            bundleId: bundle,
            bucketStartMs:
              first + Number(ordinal % bucketCount) * projection.bucketSizeMs,
          };
        });
        const keys = positions.map((position) =>
          countIdentity(
            "activeBundleSeries",
            "",
            position.bundleId,
            position.bucketStartMs,
          ),
        );
        const counts = await readCountsByKeys(
          transaction,
          provider,
          job.id,
          manifest,
          keys,
        );
        data = {
          section: "activeBundleSeries",
          data: positions.map((position, index) => ({
            ...position,
            value: counts.get(keys[index]!.key.toString("hex")) ?? 0,
          })),
          nextCursor: bounds.nextCursor,
          hasNext: bounds.nextCursor !== null,
          consistency,
          total: {
            state: "exact",
            value: exactNumber(total),
            sourceGeneration,
          },
        };
      }
      const result = { state: "ready" as const, versions: versions(job), data };
      return validatedReportPage(result, input.limit);
    } catch (error) {
      if (
        error instanceof DatabasePluginInputError &&
        error.code === "invalid-result"
      ) {
        return failReadyReportStorage(transaction, provider, job, input.limit);
      }
      throw error;
    }
  });
};
