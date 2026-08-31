import { createHash, randomUUID } from "node:crypto";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
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

const heads = "private_hot_updater_insights_report_heads";
const jobs = "private_hot_updater_insights_report_jobs";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal = /^(0|[1-9][0-9]{0,18})$/;
const nowMs = sql<number>`floor(extract(epoch from clock_timestamp()) * 1000)::double precision`;

export const assertPostgresInsightsReportClaimIndex = async (
  db: QueryExecutorProvider,
): Promise<void> => {
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
  | { readonly phase: "complete" };

export interface PostgresInsightsReportJob {
  readonly id: string;
  readonly query: InsightsReportQuery;
  readonly asOfMs: number;
  readonly sourceGeneration: string | null;
  readonly checkpoint: PostgresInsightsReportCheckpoint;
}

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

export class PostgresInsightsLeaseLostError extends Error {
  readonly code = "INSIGHTS_LEASE_LOST";
  constructor() {
    super("The PostgreSQL Insights job lease is no longer valid.");
  }
}

type StoredJob = {
  id: string;
  query_key: string;
  as_of_ms: number;
  status: "queued" | "preparing" | "ready" | "failed";
  source_generation: string | null;
  checkpoint: PostgresInsightsReportCheckpoint;
  publication: InsightsReportPublication | null;
  lease_epoch: string;
};
type Head = {
  canonical_query: InsightsReportQuery;
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
const queryIdentity = (input: InsightsReportInput) => {
  const parsed = readInsightsReportQuery(input);
  const key = createHash("sha256")
    .update(JSON.stringify([1, parsed.semanticKey]))
    .digest("hex");
  return { ...parsed, key };
};
const storedQuery = (
  query: InsightsReportQuery,
  key: string,
): InsightsReportQuery => {
  try {
    const canonical = queryIdentity({ query });
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
const checkpointValid = (value: PostgresInsightsReportCheckpoint): boolean => {
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
    default:
      return false;
  }
};
const checkpointAdvances = (
  before: PostgresInsightsReportCheckpoint,
  after: PostgresInsightsReportCheckpoint,
  query: InsightsReportQuery,
  counters: readonly string[],
): boolean => {
  if (!checkpointValid(after)) return false;
  if (before.phase === "complete") return after.phase === "complete";
  if (after.phase === "complete")
    return (
      before.phase === "installations" ||
      (query.kind === "bundleSummaries" &&
        query.bundleIds.length === 0 &&
        before.shard === 0 &&
        before.afterSequence === "0") ||
      (before.shard === 15 &&
        (query.kind === "bundleSummaries" || query.kind === "bundleDetail"))
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
      BigInt(after.afterSequence) <= BigInt(counters[after.shard]!) &&
      ((after.shard === before.shard + 1 && after.afterSequence === "0") ||
        (after.shard === before.shard &&
          BigInt(after.afterSequence) >= BigInt(before.afterSequence)))
    );
  }
  return (
    after.phase === "installations" &&
    (before.afterInstallKey === null ||
      (after.afterInstallKey !== null &&
        after.afterInstallKey >= before.afterInstallKey))
  );
};
const toJob = (
  row: StoredJob,
  query: InsightsReportQuery,
): PostgresInsightsReportJob => {
  if (
    !uuid.test(row.id) ||
    !integer(row.as_of_ms) ||
    !checkpointValid(row.checkpoint) ||
    (row.source_generation !== null &&
      (typeof row.source_generation !== "string" ||
        row.source_generation.length < 1 ||
        row.source_generation.length > 1024))
  )
    invalid();
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
const publication = (
  row: StoredJob,
  query: InsightsReportQuery,
): InsightsReportPublication => {
  const value = row.publication;
  if (row.status !== "ready" || value === null) return invalid();
  assertSummary(
    {
      kind: value.kind,
      summary: value.summary,
    } as PostgresInsightsReportSummary,
    query,
  );
  if (
    value.id !== row.id ||
    value.asOfMs !== row.as_of_ms ||
    value.sourceGeneration !== row.source_generation ||
    !integer(value.completedAtMs) ||
    value.completedAtMs < value.asOfMs ||
    value.accuracy !== "exact"
  )
    invalid();
  return value;
};

export const createPostgresInsightsJobs = <TDatabase extends object>(
  db: Kysely<TDatabase>,
) => {
  if (db.isTransaction) throw new DatabasePluginInputError("invalid-query");
  return {
    async getReport(input: InsightsReportInput): Promise<InsightsReportResult> {
      const { query, key, minAsOfMs } = queryIdentity(input);
      return db.transaction().execute(async (transaction) => {
        if (minAsOfMs !== undefined) {
          const current = (
            await sql<{ now_ms: number }>`select ${nowMs} as now_ms`.execute(
              transaction,
            )
          ).rows[0]!.now_ms;
          if (minAsOfMs > current)
            throw new DatabasePluginInputError("invalid-query");
        }
        await sql`insert into ${sql.table(heads)} (query_key, canonical_query)
          values (${key}, ${JSON.stringify(query)}::json) on conflict (query_key) do nothing`.execute(
          transaction,
        );
        const head = (
          await sql<Head>`select canonical_query, active_job_id, publication_job_id
          from ${sql.table(heads)} where query_key = ${key} for update`.execute(
            transaction,
          )
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
                await sql<StoredJob>`select *, lease_epoch::text from ${sql.table(jobs)}
          where id in (${sql.join(ids)}) limit 2`.execute(transaction)
              ).rows;
        if (
          rows.length !== ids.length ||
          rows.some((row) => row.query_key !== key)
        )
          invalid();
        const previousRow = rows.find(
          (row) => row.id === head.publication_job_id,
        );
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
        const id = randomUUID();
        await sql`insert into ${sql.table(jobs)} (id, query_key, as_of_ms, status, checkpoint)
          values (${id}::uuid, ${key}, ${nowMs}, 'queued', '{"phase":"source","shard":0,"afterSequence":"0"}'::jsonb)`.execute(
          transaction,
        );
        await sql`update ${sql.table(heads)} set active_job_id = ${id}::uuid where query_key = ${key}`.execute(
          transaction,
        );
        return { state: "queued", jobId: id, previous };
      });
    },

    async leaseNext(): Promise<{
      token: PostgresInsightsReportLeaseToken;
      job: PostgresInsightsReportJob;
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
        job: PostgresInsightsReportJob,
      ) => Promise<PostgresInsightsReportJobUpdate>,
    ): Promise<void> {
      if (
        !uuid.test(token.jobId) ||
        !sequence(token.epoch) ||
        token.epoch === "0"
      )
        throw new DatabasePluginInputError("invalid-query");
      await db.transaction().execute(async (transaction) => {
        const row = (
          await sql<
            StoredJob & {
              canonical_query: InsightsReportQuery;
              lease_valid: boolean;
            }
          >`with locked as materialized (
          select j.*, j.lease_epoch::text as epoch_text, h.canonical_query
          from ${sql.table(jobs)} j join ${sql.table(heads)} h on h.query_key = j.query_key
          where j.id = ${token.jobId}::uuid for update of j
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
          case "defer":
            updated = await sql<{
              id: string;
            }>`update ${sql.table(jobs)} set status = 'queued', claimable_at = clock_timestamp()
              where ${validLease} returning id`.execute(transaction);
            break;
          case "progress": {
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
          case "publish": {
            if (
              job.sourceGeneration === null ||
              job.checkpoint.phase !== "complete"
            )
              invalid();
            assertSummary(update.summary, job.query);
            const completedAtMs = (
              await sql<{ now_ms: number }>`select ${nowMs} as now_ms`.execute(
                transaction,
              )
            ).rows[0]!.now_ms;
            const result: InsightsReportPublication = {
              ...update.summary,
              id: job.id,
              asOfMs: job.asOfMs,
              completedAtMs,
              sourceGeneration: job.sourceGeneration!,
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
