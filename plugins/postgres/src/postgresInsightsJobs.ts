import { createHash, randomUUID } from "node:crypto";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type InsightsInstallationPublication,
  type InsightsReportInput,
  type InsightsReportPublication,
  type InsightsReportQuery,
  type InsightsReportResult,
} from "@hot-updater/plugin-core";
import { readInsightsReportQuery } from "@hot-updater/plugin-core/internal";
import {
  sql,
  type Kysely,
  type QueryExecutorProvider,
  type Transaction,
} from "kysely";

import { getPostgresInsightsReportOrderSections } from "./postgresInsightsReportSections";

const heads = "private_hot_updater_insights_report_heads";
const jobs = "private_hot_updater_insights_report_jobs";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal = /^(0|[1-9][0-9]{0,18})$/;
const hashKey = /^[0-9a-f]{64}$/;
// One current derived layout. Earlier draft jobs must be explicitly discarded.
const storageRevision = 2;
const nowMs = sql<number>`floor(extract(epoch from clock_timestamp()) * 1000)::double precision`;

export const assertPostgresInsightsReportMetadataIndexes = async (
  db: QueryExecutorProvider,
): Promise<void> => {
  const result = await sql<{ ready: boolean }>`select bool_and(exists (
    select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
    join pg_am am on am.oid = c.relam
    where i.indexrelid = to_regclass(required.index_name)
      and i.indrelid = to_regclass(required.table_name)
      and i.indisvalid and i.indisready
      and i.indisprimary = required.is_primary and i.indisunique = required.is_primary
      and i.indnkeyatts = 1 and i.indnatts = 1
      and i.indexprs is null and i.indpred is null and am.amname = 'btree'
      and pg_get_indexdef(i.indexrelid, 1, false) = required.column_name
      and not exists (select 1 from unnest(i.indoption) bits where bits <> 0)
      and not exists (select 1 from unnest(i.indclass) class_id
        join pg_opclass opclass on opclass.oid = class_id where not opclass.opcdefault)
  )) and exists (
    select 1 from pg_constraint c
    join pg_attribute parent on parent.attrelid = c.confrelid and parent.attname = 'id'
    join pg_attribute child on child.attrelid = c.conrelid and child.attname = 'base_job_id'
    join pg_attribute cutoff on cutoff.attrelid = c.conrelid and cutoff.attname = 'as_of_ms'
    where c.conrelid = to_regclass(${jobs}) and c.confrelid = c.conrelid
      and c.contype = 'f' and c.convalidated and not c.condeferrable
      and c.confdeltype = 'r' and c.conkey = array[child.attnum]
      and c.confkey = array[parent.attnum] and not cutoff.attnotnull
  ) as ready from (values
    (${heads}::text, ${`${heads}_pkey`}::text, 'query_key', true),
    (${jobs}::text, ${`${jobs}_pkey`}::text, 'id', true),
    (${jobs}::text, 'private_hot_updater_insights_report_base_idx', 'base_job_id', false)
  ) required(table_name, index_name, column_name, is_primary)`.execute(db);
  if (!result.rows[0]?.ready) throw new InsightsQueryNotReadyError();
};

export const assertPostgresInsightsReportClaimIndex = async (
  db: QueryExecutorProvider,
): Promise<void> => {
  await assertPostgresInsightsReportMetadataIndexes(db);
  const result = await sql<{ ready: boolean }>`select exists (
    select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
    join pg_am am on am.oid = c.relam
    where i.indexrelid = to_regclass('private_hot_updater_insights_report_claim_idx')
      and i.indrelid = to_regclass('private_hot_updater_insights_report_jobs')
      and i.indisvalid and i.indisready and i.indexprs is null
      and i.indnkeyatts = 2 and i.indnatts = 2 and am.amname = 'btree'
      and pg_get_indexdef(i.indexrelid, 1, false) = 'claimable_at'
      and pg_get_indexdef(i.indexrelid, 2, false) = 'id'
      and pg_get_expr(i.indpred, i.indrelid) = '(status = ANY (ARRAY[''queued''::text, ''preparing''::text]))'
      and not exists (select 1 from unnest(i.indoption) bits where bits <> 0)
      and not exists (select 1 from unnest(i.indclass) class_id
        join pg_opclass opclass on opclass.oid = class_id where not opclass.opcdefault)
  ) as ready`.execute(db);
  if (!result.rows[0]?.ready) throw new InsightsQueryNotReadyError();
};

export type PostgresInsightsReportCheckpoint =
  | {
      readonly phase: "source";
      readonly shard: number;
      readonly afterSequence: string;
    }
  | { readonly phase: "installations"; readonly afterInstallKey: string | null }
  | { readonly phase: "ordering"; readonly section: number }
  | { readonly phase: "complete" };

export interface PostgresInsightsReportJob {
  readonly id: string;
  readonly query: InsightsReportQuery;
  readonly asOfMs: number;
  readonly sourceGeneration: string | null;
  readonly checkpoint: PostgresInsightsReportCheckpoint;
}

type ContainsQuery = {
  readonly kind: "installationContains";
  readonly normalizedQuery: string;
};
type PrivateQuery = InsightsReportQuery | ContainsQuery;

export type PostgresInsightsContainsCheckpoint =
  | { readonly phase: "awaitIdentity" }
  | { readonly phase: "aliases"; readonly afterAliasKey: string | null }
  | { readonly phase: "ordering" }
  | { readonly phase: "complete" };

export interface PostgresInsightsContainsJob {
  readonly id: string;
  readonly query: ContainsQuery;
  readonly baseJobId: string;
  /** Unset until the pinned base is published; never the search reservation time. */
  readonly asOfMs: number | null;
  readonly sourceGeneration: string | null;
  readonly checkpoint: PostgresInsightsContainsCheckpoint;
}
export type PostgresInsightsJob =
  | PostgresInsightsReportJob
  | PostgresInsightsContainsJob;
export const isPostgresInsightsContainsJob = (
  job: PostgresInsightsJob,
): job is PostgresInsightsContainsJob => "baseJobId" in job;

type JobResult<TPublication> =
  | { state: "ready"; publication: TPublication }
  | {
      state: "queued" | "preparing";
      jobId: string;
      previous: TPublication | null;
    }
  | {
      state: "failed";
      error: { code: "preparation-failed"; jobId: string };
      previous: TPublication | null;
    };
export type PostgresInsightsSearchResult =
  JobResult<InsightsInstallationPublication>;
type PrivatePublication =
  | InsightsReportPublication
  | InsightsInstallationPublication;

export interface PostgresInsightsReportLeaseToken {
  readonly jobId: string;
  readonly epoch: string;
}

export type PostgresInsightsReportSummary = {
  [Kind in InsightsReportPublication["kind"]]: Pick<
    Extract<InsightsReportPublication, { kind: Kind }>,
    "kind" | "summary"
  >;
}[InsightsReportPublication["kind"]];

export type PostgresInsightsReportJobUpdate =
  | {
      readonly kind: "progress";
      readonly checkpoint: PostgresInsightsReportCheckpoint;
      readonly sourceGeneration?: string;
    }
  | {
      readonly kind: "publish";
      readonly summary: PostgresInsightsReportSummary;
    }
  | { readonly kind: "defer" }
  | { readonly kind: "fail" };

export type PostgresInsightsJobUpdate =
  | PostgresInsightsReportJobUpdate
  | { readonly kind: "bindIdentity" }
  | {
      readonly kind: "progress";
      readonly checkpoint: PostgresInsightsContainsCheckpoint;
      readonly sourceGeneration?: never;
    }
  | { readonly kind: "publishSearch"; readonly total: number };

export class PostgresInsightsLeaseLostError extends Error {
  readonly code = "INSIGHTS_LEASE_LOST";
  constructor() {
    super("The PostgreSQL Insights job lease is no longer valid.");
  }
}

type StoredJob = {
  id: string;
  query_key: string;
  as_of_ms: number | null;
  base_job_id: string | null;
  status: "queued" | "preparing" | "ready" | "failed";
  source_generation: string | null;
  checkpoint:
    | PostgresInsightsReportCheckpoint
    | PostgresInsightsContainsCheckpoint;
  publication: PrivatePublication | null;
  lease_epoch: string;
};
type Head = {
  canonical_query: PrivateQuery;
  active_job_id: string | null;
  publication_job_id: string | null;
};

const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const sequence = (value: unknown): value is string =>
  typeof value === "string" &&
  decimal.test(value) &&
  BigInt(value) <= 9_223_372_036_854_775_807n;
const only = (value: object, fields: readonly string[]) =>
  Object.keys(value).every((key) => fields.includes(key));
const queryIdentity = (query: PrivateQuery) => {
  const parsed =
    query.kind === "installationContains"
      ? (() => {
          if (
            !only(query, ["kind", "normalizedQuery"]) ||
            typeof query.normalizedQuery !== "string" ||
            !query.normalizedQuery.length ||
            query.normalizedQuery !== query.normalizedQuery.toLowerCase()
          )
            invalid();
          return {
            query,
            semanticKey: JSON.stringify([1, query.kind, query.normalizedQuery]),
          };
        })()
      : readInsightsReportQuery({ query });
  const key = createHash("sha256")
    .update(JSON.stringify([storageRevision, parsed.semanticKey]))
    .digest("hex");
  return { ...parsed, key };
};
const storedQuery = (query: PrivateQuery, key: string): PrivateQuery => {
  try {
    const canonical = queryIdentity(query);
    if (canonical.key !== key) invalid();
    return canonical.query;
  } catch {
    return invalid();
  }
};
const sourceCounters = (generation: string): readonly string[] => {
  try {
    if (typeof generation !== "string" || generation.length > 1024)
      return invalid();
    const value = JSON.parse(generation);
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value[0] !== 1 ||
      typeof value[1] !== "string" ||
      !uuid.test(value[1]) ||
      !Array.isArray(value[2]) ||
      value[2].length !== 16 ||
      !value[2].every(sequence)
    )
      return invalid();
    return value[2];
  } catch {
    return invalid();
  }
};
const checkpointValid = (
  value: StoredJob["checkpoint"],
): value is PostgresInsightsReportCheckpoint => {
  if (typeof value !== "object" || value === null) return false;
  switch (value.phase) {
    case "source":
      return (
        only(value, ["phase", "shard", "afterSequence"]) &&
        integer(value.shard) &&
        value.shard < 16 &&
        sequence(value.afterSequence)
      );
    case "installations":
      return (
        only(value, ["phase", "afterInstallKey"]) &&
        (value.afterInstallKey === null ||
          (typeof value.afterInstallKey === "string" &&
            value.afterInstallKey.length > 0 &&
            value.afterInstallKey.length <= 8192))
      );
    case "complete":
      return only(value, ["phase"]);
    case "ordering":
      return (
        only(value, ["phase", "section"]) &&
        "section" in value &&
        integer(value.section) &&
        value.section < 2
      );
    default:
      return false;
  }
};
const containsCheckpointValid = (
  value: StoredJob["checkpoint"],
): value is PostgresInsightsContainsCheckpoint => {
  if (typeof value !== "object" || value === null) return false;
  switch (value.phase) {
    case "awaitIdentity":
    case "ordering":
    case "complete":
      return only(value, ["phase"]);
    case "aliases":
      return (
        only(value, ["phase", "afterAliasKey"]) &&
        (value.afterAliasKey === null ||
          (typeof value.afterAliasKey === "string" &&
            hashKey.test(value.afterAliasKey)))
      );
    default:
      return false;
  }
};
const containsCheckpointAdvances = (
  before: PostgresInsightsContainsCheckpoint,
  after: StoredJob["checkpoint"],
): boolean => {
  if (!containsCheckpointValid(after)) return false;
  if (before.phase === "aliases")
    return (
      after.phase === "ordering" ||
      (after.phase === "aliases" &&
        (before.afterAliasKey === null ||
          (after.afterAliasKey !== null &&
            after.afterAliasKey >= before.afterAliasKey)))
    );
  return before.phase === "ordering"
    ? after.phase === "ordering" || after.phase === "complete"
    : before.phase === "complete" && after.phase === "complete";
};
const checkpointAdvances = (
  before: PostgresInsightsReportCheckpoint,
  after: StoredJob["checkpoint"],
  query: InsightsReportQuery,
  counters: readonly string[],
): boolean => {
  if (!checkpointValid(after)) return false;
  if (before.phase === "complete") return after.phase === "complete";
  const sections = getPostgresInsightsReportOrderSections(query);
  if (after.phase === "complete")
    return (
      (before.phase === "ordering" && before.section === sections.length - 1) ||
      (before.phase === "source" &&
        query.kind === "bundleSummaries" &&
        (before.shard === 15 ||
          (query.bundleIds.length === 0 &&
            before.shard === 0 &&
            before.afterSequence === "0")))
    );
  if (after.phase === "ordering")
    return (
      after.section < sections.length &&
      ((before.phase === "ordering" &&
        (after.section === before.section ||
          after.section === before.section + 1)) ||
        (after.section === 0 &&
          ((before.phase === "source" &&
            before.shard === 15 &&
            query.kind === "bundleDetail") ||
            (before.phase === "installations" &&
              (query.kind === "installationOverview" ||
                query.kind === "activeOverview")))))
    );
  if (before.phase === "source") {
    if (after.phase === "installations")
      return (
        before.shard === 15 &&
        after.afterInstallKey === null &&
        (query.kind === "installationOverview" ||
          query.kind === "activeOverview")
      );
    return (
      after.phase === "source" &&
      BigInt(after.afterSequence) <= BigInt(counters[after.shard]!) &&
      ((after.shard === before.shard + 1 && after.afterSequence === "0") ||
        (after.shard === before.shard &&
          BigInt(after.afterSequence) >= BigInt(before.afterSequence)))
    );
  }
  return (
    before.phase === "installations" &&
    after.phase === "installations" &&
    (before.afterInstallKey === null ||
      (after.afterInstallKey !== null &&
        after.afterInstallKey >= before.afterInstallKey))
  );
};
const toJob = (row: StoredJob, query: PrivateQuery): PostgresInsightsJob => {
  if (
    !uuid.test(row.id) ||
    (row.source_generation !== null &&
      (typeof row.source_generation !== "string" ||
        row.source_generation.length < 1 ||
        row.source_generation.length > 1024))
  )
    invalid();
  if (query.kind === "installationContains") {
    if (
      typeof row.base_job_id !== "string" ||
      !uuid.test(row.base_job_id) ||
      row.base_job_id === row.id ||
      !containsCheckpointValid(row.checkpoint)
    )
      return invalid();
    if (row.checkpoint.phase === "awaitIdentity") {
      if (row.as_of_ms !== null || row.source_generation !== null) invalid();
    } else {
      if (!integer(row.as_of_ms) || row.source_generation === null)
        return invalid();
      sourceCounters(row.source_generation);
    }
    return {
      id: row.id,
      query,
      baseJobId: row.base_job_id,
      asOfMs: row.as_of_ms,
      sourceGeneration: row.source_generation,
      checkpoint: row.checkpoint,
    };
  }
  if (
    !integer(row.as_of_ms) ||
    row.base_job_id !== null ||
    !checkpointValid(row.checkpoint) ||
    (row.checkpoint.phase === "ordering" &&
      row.checkpoint.section >=
        getPostgresInsightsReportOrderSections(query).length)
  )
    return invalid();
  return {
    id: row.id,
    query,
    asOfMs: row.as_of_ms,
    sourceGeneration: row.source_generation,
    checkpoint: row.checkpoint,
  };
};
const assertSummary = (
  value: PostgresInsightsReportSummary,
  query: InsightsReportQuery,
): void => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !only(value, ["kind", "summary"]) ||
    value.kind !== query.kind
  )
    invalid();
  const counts = (summary: { installed: number; recovered: number }) =>
    typeof summary === "object" &&
    summary !== null &&
    !Array.isArray(summary) &&
    integer(summary.installed) &&
    integer(summary.recovered);
  switch (value.kind) {
    case "bundleSummaries":
      if (
        query.kind !== "bundleSummaries" ||
        !Array.isArray(value.summary) ||
        value.summary.length !== query.bundleIds.length ||
        !Array.from(value.summary).every(
          (row, index) =>
            counts(row) &&
            only(row, ["bundleId", "installed", "recovered"]) &&
            row.bundleId === query.bundleIds[index],
        )
      )
        invalid();
      break;
    case "bundleDetail":
      if (
        !counts(value.summary) ||
        !only(value.summary, ["installed", "recovered"])
      )
        invalid();
      break;
    case "installationOverview":
      if (
        typeof value.summary !== "object" ||
        value.summary === null ||
        Array.isArray(value.summary) ||
        !only(value.summary, ["trackedInstallations"]) ||
        !integer(value.summary.trackedInstallations)
      )
        invalid();
      break;
    case "activeOverview":
      if (
        typeof value.summary !== "object" ||
        value.summary === null ||
        Array.isArray(value.summary) ||
        !only(value.summary, ["activeInstallations"]) ||
        !integer(value.summary.activeInstallations)
      )
        invalid();
      break;
    default:
      invalid();
  }
};
function publication(
  row: StoredJob,
  query: InsightsReportQuery,
): InsightsReportPublication;
function publication(
  row: StoredJob,
  query: ContainsQuery,
): InsightsInstallationPublication;
function publication(row: StoredJob, query: PrivateQuery): PrivatePublication;
function publication(row: StoredJob, query: PrivateQuery): PrivatePublication {
  const value = row.publication;
  if (row.status !== "ready" || value === null) return invalid();
  if (
    row.checkpoint.phase !== "complete" ||
    row.source_generation === null ||
    value.id !== row.id ||
    value.asOfMs !== row.as_of_ms ||
    value.sourceGeneration !== row.source_generation ||
    !integer(value.completedAtMs) ||
    value.completedAtMs < value.asOfMs ||
    value.accuracy !== "exact"
  )
    invalid();
  if (query.kind === "installationContains") {
    if (
      !("total" in value) ||
      !integer(value.total) ||
      !only(value, [
        "id",
        "asOfMs",
        "completedAtMs",
        "sourceGeneration",
        "accuracy",
        "total",
      ])
    )
      return invalid();
  } else {
    if (!("kind" in value)) return invalid();
    assertSummary(
      {
        kind: value.kind,
        summary: value.summary,
      } as PostgresInsightsReportSummary,
      query,
    );
  }
  return value;
}

export const normalizePostgresInsightsSearchQuery = (
  query: unknown,
): string => {
  if (typeof query !== "string" || query.length === 0)
    throw new DatabasePluginInputError("invalid-query");
  return query.toLowerCase();
};

const readJobRow = async (db: QueryExecutorProvider, publicationId: string) => {
  if (typeof publicationId !== "string" || !uuid.test(publicationId))
    throw new DatabasePluginInputError("invalid-query");
  await assertPostgresInsightsReportMetadataIndexes(db);
  return (
    await sql<StoredJob & { canonical_query: PrivateQuery }>`
    select j.*, j.lease_epoch::text, h.canonical_query
    from ${sql.table(jobs)} j join ${sql.table(heads)} h on h.query_key = j.query_key
    where j.id = ${publicationId}::uuid`.execute(db)
  ).rows[0];
};

/** A primary-key lookup; old immutable publications need not be the current head. */
export const readPostgresInsightsReportPublication = async (
  db: QueryExecutorProvider,
  publicationId: string,
): Promise<{
  job: PostgresInsightsReportJob;
  publication: InsightsReportPublication;
} | null> => {
  const row = await readJobRow(db, publicationId);
  if (row === undefined) return null;
  const query = storedQuery(row.canonical_query, row.query_key);
  const job = toJob(row, query);
  if (
    isPostgresInsightsContainsJob(job) ||
    query.kind === "installationContains"
  )
    throw new DatabasePluginInputError("invalid-query");
  if (row.status !== "ready") throw new InsightsQueryNotReadyError();
  return { job, publication: publication(row, query) };
};

/** A pinned search lookup never reserves a search or refreshes its base. */
export const readPostgresInsightsSearchPublication = async (
  db: QueryExecutorProvider,
  publicationId: string,
  normalizedQuery: string,
): Promise<{
  job: PostgresInsightsContainsJob;
  publication: InsightsInstallationPublication;
} | null> => {
  if (normalizePostgresInsightsSearchQuery(normalizedQuery) !== normalizedQuery)
    throw new DatabasePluginInputError("invalid-query");
  const row = await readJobRow(db, publicationId);
  if (row === undefined) return null;
  const query = storedQuery(row.canonical_query, row.query_key);
  const job = toJob(row, query);
  if (
    !isPostgresInsightsContainsJob(job) ||
    query.kind !== "installationContains" ||
    query.normalizedQuery !== normalizedQuery
  )
    throw new DatabasePluginInputError("invalid-query");
  if (row.status !== "ready") throw new InsightsQueryNotReadyError();
  return { job, publication: publication(row, query) };
};

function reserveQuery(
  db: QueryExecutorProvider,
  query: InsightsReportQuery,
  minAsOfMs?: number,
): Promise<JobResult<InsightsReportPublication>>;
function reserveQuery(
  db: QueryExecutorProvider,
  query: ContainsQuery,
  minAsOfMs?: number,
): Promise<PostgresInsightsSearchResult>;
async function reserveQuery(
  db: QueryExecutorProvider,
  input: PrivateQuery,
  minAsOfMs?: number,
): Promise<JobResult<PrivatePublication>> {
  const { query, key } = queryIdentity(input);
  await sql`insert into ${sql.table(heads)} (query_key, canonical_query)
    values (${key}, ${JSON.stringify(query)}::json) on conflict (query_key) do nothing`.execute(
    db,
  );
  const head = (
    await sql<Head>`select canonical_query, active_job_id, publication_job_id
    from ${sql.table(heads)} where query_key = ${key} for update`.execute(db)
  ).rows[0]!;
  if (
    JSON.stringify(storedQuery(head.canonical_query, key)) !==
    JSON.stringify(query)
  )
    invalid();
  const ids = [
    ...new Set(
      [head.active_job_id, head.publication_job_id].filter(
        (id): id is string => id !== null,
      ),
    ),
  ];
  const rows =
    ids.length === 0
      ? []
      : (
          await sql<StoredJob>`select *, lease_epoch::text
    from ${sql.table(jobs)} where id in (${sql.join(ids)}) limit 2`.execute(db)
        ).rows;
  if (rows.length !== ids.length || rows.some((row) => row.query_key !== key))
    invalid();
  for (const row of rows) toJob(row, query);
  const previousRow = rows.find((row) => row.id === head.publication_job_id);
  const previous =
    previousRow === undefined ? null : publication(previousRow, query);
  if (
    previous !== null &&
    (minAsOfMs === undefined || previous.asOfMs >= minAsOfMs)
  )
    return { state: "ready", publication: previous };
  const active = rows.find((row) => row.id === head.active_job_id);
  if (active !== undefined) {
    if (active.status === "queued" || active.status === "preparing")
      return { state: active.status, jobId: active.id, previous };
    if (active.status === "failed")
      return {
        state: "failed",
        error: { code: "preparation-failed", jobId: active.id },
        previous,
      };
    return invalid();
  }

  let baseJobId: string | null = null;
  let status: "queued" | "failed" = "queued";
  if (query.kind === "installationContains") {
    // Both heads and the FK pin commit together. Repeated searches return above
    // without touching the global head, let alone refreshing raw source data.
    const base = await reserveQuery(
      db,
      { kind: "installationOverview" },
      minAsOfMs,
    );
    baseJobId =
      base.state === "ready"
        ? base.publication.id
        : base.state === "failed"
          ? base.error.jobId
          : base.jobId;
    if (base.state === "failed") status = "failed";
  }
  const id = randomUUID();
  const checkpoint =
    baseJobId === null
      ? { phase: "source", shard: 0, afterSequence: "0" }
      : { phase: "awaitIdentity" };
  await sql`insert into ${sql.table(jobs)} (id, query_key, base_job_id, as_of_ms, status, checkpoint)
    values (${id}::uuid, ${key}, ${baseJobId}::uuid, ${baseJobId === null ? nowMs : sql`null`},
      ${status}, ${JSON.stringify(checkpoint)}::jsonb)`.execute(db);
  await sql`update ${sql.table(heads)} set active_job_id = ${id}::uuid where query_key = ${key}`.execute(
    db,
  );
  return status === "failed"
    ? {
        state: "failed",
        error: { code: "preparation-failed", jobId: id },
        previous,
      }
    : { state: "queued", jobId: id, previous };
}

const checkFreshness = async (
  db: QueryExecutorProvider,
  minAsOfMs: number | undefined,
) => {
  if (minAsOfMs !== undefined) {
    const current = (
      await sql<{ now_ms: number }>`select ${nowMs} as now_ms`.execute(db)
    ).rows[0]!.now_ms;
    if (minAsOfMs > current)
      throw new DatabasePluginInputError("invalid-query");
  }
};

export const createPostgresInsightsJobs = <TDatabase extends object>(
  db: Kysely<TDatabase>,
) => {
  if (db.isTransaction) throw new DatabasePluginInputError("invalid-query");
  return {
    async getReport(input: InsightsReportInput): Promise<InsightsReportResult> {
      const { query, minAsOfMs } = readInsightsReportQuery(input);
      return db.transaction().execute(async (transaction) => {
        await assertPostgresInsightsReportMetadataIndexes(transaction);
        await checkFreshness(transaction, minAsOfMs);
        return reserveQuery(transaction, query, minAsOfMs);
      });
    },

    async getSearch(input: {
      query: string;
      minAsOfMs?: number;
    }): Promise<PostgresInsightsSearchResult> {
      if (
        typeof input !== "object" ||
        input === null ||
        Array.isArray(input) ||
        !only(input, ["query", "minAsOfMs"]) ||
        (input.minAsOfMs !== undefined && !integer(input.minAsOfMs))
      )
        throw new DatabasePluginInputError("invalid-query");
      const query: ContainsQuery = {
        kind: "installationContains",
        normalizedQuery: normalizePostgresInsightsSearchQuery(input.query),
      };
      return db.transaction().execute(async (transaction) => {
        await assertPostgresInsightsReportMetadataIndexes(transaction);
        await checkFreshness(transaction, input.minAsOfMs);
        return reserveQuery(transaction, query, input.minAsOfMs);
      });
    },

    async leaseNext(): Promise<{
      token: PostgresInsightsReportLeaseToken;
      job: PostgresInsightsJob;
    } | null> {
      return db.transaction().execute(async (transaction) => {
        await assertPostgresInsightsReportClaimIndex(transaction);
        const row = (
          await sql<StoredJob>`with candidate as materialized (
          select id from ${sql.table(jobs)} where status in ('queued', 'preparing') and claimable_at <= statement_timestamp()
          order by claimable_at, id limit 1
        ), locked as materialized (
          select j.id from ${sql.table(jobs)} j join candidate c on j.id = c.id
          where j.status in ('queued', 'preparing') and j.claimable_at <= statement_timestamp()
          for update of j skip locked
        ) update ${sql.table(jobs)} j set status = 'preparing', lease_epoch = lease_epoch + 1,
          claimable_at = clock_timestamp() + interval '30 seconds' from locked c where j.id = c.id
          returning j.*, j.lease_epoch::text`.execute(transaction)
        ).rows[0];
        if (row === undefined) return null;
        const head = (
          await sql<Head>`select canonical_query, active_job_id, publication_job_id
          from ${sql.table(heads)} where query_key = ${row.query_key}`.execute(
            transaction,
          )
        ).rows[0];
        if (head?.active_job_id !== row.id || !sequence(row.lease_epoch))
          invalid();
        return {
          token: { jobId: row.id, epoch: row.lease_epoch },
          job: toJob(row, storedQuery(head.canonical_query, row.query_key)),
        };
      });
    },

    async withLease(
      token: PostgresInsightsReportLeaseToken,
      callback: (
        transaction: Transaction<TDatabase>,
        job: PostgresInsightsJob,
      ) => Promise<PostgresInsightsJobUpdate>,
    ): Promise<void> {
      if (
        !uuid.test(token.jobId) ||
        !sequence(token.epoch) ||
        token.epoch === "0"
      )
        throw new DatabasePluginInputError("invalid-query");
      await db.transaction().execute(async (transaction) => {
        await assertPostgresInsightsReportMetadataIndexes(transaction);
        const row = (
          await sql<
            StoredJob & {
              canonical_query: PrivateQuery;
              lease_valid: boolean;
            }
          >`with locked as materialized (
          select j.*, j.lease_epoch::text as epoch_text, h.canonical_query
          from ${sql.table(jobs)} j join ${sql.table(heads)} h on h.query_key = j.query_key
          where j.id = ${token.jobId}::uuid for no key update of j
        ) select locked.*, epoch_text as lease_epoch, claimable_at > clock_timestamp() as lease_valid from locked`.execute(
            transaction,
          )
        ).rows[0];
        if (
          !row ||
          row.status !== "preparing" ||
          row.lease_epoch !== token.epoch ||
          !row.lease_valid
        )
          throw new PostgresInsightsLeaseLostError();
        const job = toJob(row, storedQuery(row.canonical_query, row.query_key));
        const update = await callback(transaction, job);
        let updated: { rows: { id: string }[] };
        const validLease = sql`id = ${job.id}::uuid and status = 'preparing' and lease_epoch = ${token.epoch}::bigint and claimable_at > clock_timestamp()`;
        switch (update.kind) {
          case "bindIdentity": {
            if (
              !isPostgresInsightsContainsJob(job) ||
              job.checkpoint.phase !== "awaitIdentity"
            )
              return invalid();
            const base = (
              await sql<StoredJob & { canonical_query: PrivateQuery }>`
              select j.*, j.lease_epoch::text, h.canonical_query from ${sql.table(jobs)} j
              join ${sql.table(heads)} h on h.query_key = j.query_key
              where j.id = ${job.baseJobId}::uuid`.execute(transaction)
            ).rows[0];
            if (!base) return invalid();
            const baseQuery = storedQuery(base.canonical_query, base.query_key);
            const baseJob = toJob(base, baseQuery);
            if (
              isPostgresInsightsContainsJob(baseJob) ||
              baseQuery.kind !== "installationOverview"
            )
              return invalid();
            if (base.status === "ready") {
              const snapshot = publication(base, baseQuery);
              sourceCounters(snapshot.sourceGeneration);
              updated = await sql<{ id: string }>`update ${sql.table(jobs)}
                set as_of_ms = ${snapshot.asOfMs}, source_generation = ${snapshot.sourceGeneration},
                  checkpoint = '{"phase":"aliases","afterAliasKey":null}'::jsonb,
                  status = 'queued', claimable_at = clock_timestamp()
                where ${validLease} returning id`.execute(transaction);
            } else if (
              base.status === "queued" ||
              base.status === "preparing" ||
              base.status === "failed"
            ) {
              updated = await sql<{ id: string }>`update ${sql.table(jobs)}
                set status = ${base.status === "failed" ? "failed" : "queued"}, claimable_at = clock_timestamp()
                where ${validLease} returning id`.execute(transaction);
            } else return invalid();
            break;
          }
          case "defer":
            updated = await sql<{
              id: string;
            }>`update ${sql.table(jobs)} set status = 'queued', claimable_at = clock_timestamp()
              where ${validLease} returning id`.execute(transaction);
            break;
          case "progress": {
            if (isPostgresInsightsContainsJob(job)) {
              if (
                update.sourceGeneration !== undefined ||
                job.sourceGeneration === null ||
                !containsCheckpointAdvances(job.checkpoint, update.checkpoint)
              )
                return invalid();
              updated = await sql<{ id: string }>`update ${sql.table(jobs)}
                set checkpoint = ${JSON.stringify(update.checkpoint)}::jsonb,
                  status = 'queued', claimable_at = clock_timestamp()
                where ${validLease} returning id`.execute(transaction);
              break;
            }
            const generation = update.sourceGeneration ?? job.sourceGeneration;
            if (
              typeof generation !== "string" ||
              (job.sourceGeneration !== null &&
                generation !== job.sourceGeneration)
            )
              return invalid();
            if (
              !checkpointAdvances(
                job.checkpoint,
                update.checkpoint,
                job.query,
                sourceCounters(generation),
              )
            )
              invalid();
            updated = await sql<{
              id: string;
            }>`update ${sql.table(jobs)} set source_generation = ${generation},
              checkpoint = ${JSON.stringify(update.checkpoint)}::jsonb, status = 'queued', claimable_at = clock_timestamp()
              where ${validLease} returning id`.execute(transaction);
            break;
          }
          case "fail":
            updated = await sql<{
              id: string;
            }>`update ${sql.table(jobs)} set status = 'failed' where ${validLease} returning id`.execute(
              transaction,
            );
            break;
          case "publish":
          case "publishSearch": {
            if (
              job.sourceGeneration === null ||
              job.asOfMs === null ||
              job.checkpoint.phase !== "complete"
            )
              return invalid();
            let output: PostgresInsightsReportSummary | { total: number };
            if (update.kind === "publishSearch") {
              if (!isPostgresInsightsContainsJob(job) || !integer(update.total))
                return invalid();
              output = { total: update.total };
            } else {
              if (isPostgresInsightsContainsJob(job)) return invalid();
              assertSummary(update.summary, job.query);
              output = update.summary;
            }
            const completedAtMs = (
              await sql<{ now_ms: number }>`select ${nowMs} as now_ms`.execute(
                transaction,
              )
            ).rows[0]!.now_ms;
            const result: PrivatePublication = {
              ...output,
              id: job.id,
              asOfMs: job.asOfMs,
              completedAtMs,
              sourceGeneration: job.sourceGeneration,
              accuracy: "exact",
            };
            const promoted = await sql<{
              query_key: string;
            }>`update ${sql.table(heads)} set active_job_id = null, publication_job_id = ${job.id}::uuid
              where query_key = ${row.query_key} and active_job_id = ${job.id}::uuid returning query_key`.execute(
              transaction,
            );
            if (promoted.rows.length !== 1)
              throw new PostgresInsightsLeaseLostError();
            // Check the lease after any head-lock wait, immediately before the
            // final mutation. Failure rolls back both promotion and callback writes.
            updated = await sql<{
              id: string;
            }>`update ${sql.table(jobs)} set status = 'ready', publication = ${JSON.stringify(result)}::json
              where ${validLease} returning id`.execute(transaction);
            break;
          }
          default:
            return invalid();
        }
        if (updated.rows.length !== 1)
          throw new PostgresInsightsLeaseLostError();
      });
    },
  };
};
