import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsMovementMetric,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventRow,
  createInsightsReportProjection,
  type InsightsReportProjection,
} from "@hot-updater/plugin-core/internal";
import { sql, type QueryExecutorProvider } from "kysely";

import type {
  PostgresInsightsReportJob,
  PostgresInsightsReportSummary,
} from "./postgresInsightsJobs";

const members = "private_hot_updater_insights_report_members";
const latest = "private_hot_updater_insights_report_latest";
const counts = "private_hot_updater_insights_report_counts";
const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};
const key = (identity: string) =>
  createHash("sha256").update(identity).digest("hex");

export const assertPostgresInsightsReportDataIndexes = async (
  db: QueryExecutorProvider,
): Promise<void> => {
  const required = [
    [members, `${members}_pkey`, true, ["job_id", "member_key"]],
    [latest, `${latest}_pkey`, true, ["job_id", "install_key", "bucket_index"]],
    [
      latest,
      "insights_report_latest_installations_idx",
      false,
      ["job_id", "bucket_index", "install_key"],
    ],
    [counts, `${counts}_pkey`, true, ["job_id", "count_key"]],
    [
      counts,
      "insights_report_counts_bucket_idx",
      false,
      ["job_id", "section", "metric", "bucket_start_ms"],
    ],
  ] as const;
  const result = await sql<{ ready: boolean }>`select bool_and(exists (
    select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
    join pg_am am on am.oid = c.relam
    where i.indexrelid = to_regclass(required.index_name)
      and i.indrelid = to_regclass(required.table_name)
      and i.indisvalid and i.indisready and i.indisunique = required.is_unique
      and i.indnkeyatts = cardinality(required.columns)
      and i.indnatts = cardinality(required.columns)
      and i.indexprs is null and am.amname = 'btree'
      and case when required.index_name = 'insights_report_counts_bucket_idx'
        then pg_get_expr(i.indpred, i.indrelid) = '(section = ''movementSeries''::text)'
        else i.indpred is null end
      and not exists (select 1 from unnest(required.columns) with ordinality col(name, position)
        where pg_get_indexdef(i.indexrelid, col.position::int, false) <> col.name)
      and not exists (select 1 from unnest(i.indoption) bits where bits <> 0)
      and not exists (select 1 from unnest(i.indclass) class_id
        join pg_opclass opclass on opclass.oid = class_id where not opclass.opcdefault)
  )) as ready from (values ${sql.join(
    required.map(
      ([table, index, unique, columns]) =>
        sql`(${table}::text, ${index}::text, ${unique}::boolean, array[${sql.join(columns)}]::text[])`,
    ),
  )})
    required(table_name, index_name, is_unique, columns)`.execute(db);
  if (!result.rows[0]?.ready) throw new InsightsQueryNotReadyError();
};

export type PostgresInsightsReportCount =
  | ["summary", InsightsMovementMetric, string, -1]
  | ["movementSeries", InsightsMovementMetric, "", number]
  | ["movementCohorts", InsightsMovementMetric, string, -1]
  | ["installations", "", "", -1]
  | ["bundleDistribution" | "activeBundleTotals", "", string, -1]
  | ["activeSeries", "", "", number]
  | ["activeBundleSeries", "", string, number];

type Count = PostgresInsightsReportCount;

const increment = async (
  db: QueryExecutorProvider,
  jobId: string,
  count: Count,
) => {
  const identity = JSON.stringify(count);
  const result = await sql<{ value: string }>`insert into ${sql.table(counts)}
    (job_id, count_key, identity, section, metric, label, bucket_start_ms, value)
    values (${jobId}::uuid, ${key(identity)}, ${identity}::jsonb,
      ${count[0]}, ${count[1]}, ${count[2]}, ${count[3]}, 1)
    on conflict (job_id, count_key) do update
      set value = ${sql.table(counts)}.value + 1
      where ${sql.table(counts)}.identity = excluded.identity
    returning value::text`.execute(db);
  if (result.rows.length !== 1) invalid();
  // Fail the transaction rather than publish rounded JavaScript counts.
  if (!Number.isSafeInteger(Number(result.rows[0]!.value))) invalid();
};

const addMembership = async (
  db: QueryExecutorProvider,
  jobId: string,
  count: Count,
  installId: string,
) => {
  const identity = JSON.stringify([count, installId]);
  const memberKey = key(identity);
  const added = await sql<{
    member_key: string;
  }>`insert into ${sql.table(members)}
    (job_id, member_key, identity) values (${jobId}::uuid, ${memberKey}, ${identity}::jsonb)
    on conflict (job_id, member_key) do nothing returning member_key`.execute(
    db,
  );
  if (added.rows.length === 1) {
    await increment(db, jobId, count);
  } else {
    const existing = await sql<{
      same: boolean;
    }>`select identity = ${identity}::jsonb as same
      from ${sql.table(members)} where job_id = ${jobId}::uuid and member_key = ${memberKey}`.execute(
      db,
    );
    if (!existing.rows[0]?.same) invalid();
  }
};

const saveLatest = async (
  db: QueryExecutorProvider,
  jobId: string,
  event: BundleEventRow,
  bucketIndex: number,
) => {
  const saved = await sql<{
    install_key: string;
  }>`insert into ${sql.table(latest)}
    (job_id, install_key, bucket_index, install_id, event)
    values (${jobId}::uuid, ${key(JSON.stringify(event.install_id))}, ${bucketIndex},
      ${event.install_id}, ${JSON.stringify(event)}::jsonb)
    on conflict (job_id, install_key, bucket_index) do update set event = case
      when (excluded.event->>'received_at_ms')::bigint > (${sql.table(latest)}.event->>'received_at_ms')::bigint
        or ((excluded.event->>'received_at_ms')::bigint = (${sql.table(latest)}.event->>'received_at_ms')::bigint
          and (excluded.event->>'id') collate "C" > (${sql.table(latest)}.event->>'id') collate "C")
      then excluded.event else ${sql.table(latest)}.event end
    where ${sql.table(latest)}.install_id = excluded.install_id
    returning install_key`.execute(db);
  if (saved.rows.length !== 1) invalid();
};

/** The caller must commit these writes together with its leased checkpoint. */
export const savePostgresInsightsProjection = async (
  db: QueryExecutorProvider,
  job: PostgresInsightsReportJob,
  projection: InsightsReportProjection,
): Promise<void> => {
  if (projection.kind === "movement") {
    const { metric, bundleId, installId, bucketStartMs, cohort } = projection;
    await addMembership(
      db,
      job.id,
      ["summary", metric, bundleId, -1],
      installId,
    );
    if (job.query.kind === "bundleDetail") {
      await addMembership(
        db,
        job.id,
        ["movementSeries", metric, "", bucketStartMs],
        installId,
      );
      await addMembership(
        db,
        job.id,
        ["movementCohorts", metric, cohort, -1],
        installId,
      );
    }
    return;
  }
  await saveLatest(db, job.id, projection.event, -1);
  if (projection.bucketStartMs !== null) {
    const range = createInsightsReportProjection(job.query, job.asOfMs);
    await saveLatest(
      db,
      job.id,
      projection.event,
      (projection.bucketStartMs - range.firstBucketMs!) / range.bucketSizeMs,
    );
  }
};

export const readPostgresInsightsInstallations = async (
  db: QueryExecutorProvider,
  jobId: string,
  after: string | null,
  limit: number,
): Promise<readonly { installKey: string; event: BundleEventRow }[]> => {
  const result = await sql<{
    install_key: string;
    install_id: string;
    event: BundleEventRow;
  }>`
    select install_key, install_id, event from ${sql.table(latest)}
    where job_id = ${jobId}::uuid and bucket_index = -1
      ${after === null ? sql`` : sql`and install_key > ${after}`}
    order by install_key limit ${limit}`.execute(db);
  if (result.rows.length > limit) invalid();
  let previous = after;
  return result.rows.map((row) => {
    assertInsightsEventRow(row.event);
    if (
      row.install_id !== row.event.install_id ||
      key(JSON.stringify(row.install_id)) !== row.install_key ||
      (previous !== null && row.install_key <= previous)
    )
      invalid();
    previous = row.install_key;
    return { installKey: row.install_key, event: row.event };
  });
};

export const countPostgresInsightsInstallation = async (
  db: QueryExecutorProvider,
  job: PostgresInsightsReportJob,
  row: { installKey: string; event: BundleEventRow },
): Promise<void> => {
  if (
    job.query.kind !== "installationOverview" &&
    job.query.kind !== "activeOverview"
  )
    invalid();
  if (
    job.query.kind === "activeOverview" &&
    job.query.userId !== undefined &&
    row.event.user_id !== job.query.userId
  )
    return;
  await increment(db, job.id, ["installations", "", "", -1]);
  await increment(db, job.id, [
    "bundleDistribution",
    "",
    row.event.to_bundle_id,
    -1,
  ]);
  if (job.query.kind === "installationOverview") return;
  const range = createInsightsReportProjection(job.query, job.asOfMs);
  const buckets = await sql<{
    bucket_index: number;
    install_id: string;
    event: BundleEventRow;
  }>`select bucket_index, install_id, event
    from ${sql.table(latest)} where job_id = ${job.id}::uuid and install_key = ${row.installKey}
      and bucket_index >= 0 order by bucket_index limit 31`.execute(db);
  if (buckets.rows.length > 30) invalid();
  for (const bucket of buckets.rows) {
    assertInsightsEventRow(bucket.event);
    const projected = range.project(bucket.event);
    const bucketStartMs =
      range.firstBucketMs! + bucket.bucket_index * range.bucketSizeMs;
    if (
      bucket.install_id !== row.event.install_id ||
      bucket.event.install_id !== row.event.install_id ||
      projected?.kind !== "installation" ||
      projected.bucketStartMs !== bucketStartMs
    )
      invalid();
    await increment(db, job.id, ["activeSeries", "", "", bucketStartMs]);
    await increment(db, job.id, [
      "activeBundleSeries",
      "",
      bucket.event.to_bundle_id,
      bucketStartMs,
    ]);
    await increment(db, job.id, [
      "activeBundleTotals",
      "",
      bucket.event.to_bundle_id,
      -1,
    ]);
  }
};

/** Fixed hash point reads; never bind an opaque query ID as PostgreSQL text. */
export const readPostgresInsightsReportCounts = async (
  db: QueryExecutorProvider,
  jobId: string,
  requested: readonly Count[],
): Promise<readonly number[]> => {
  if (requested.length > 200) invalid();
  const byKey = new Map<string, { identity: string; value: number }>();
  for (const count of requested) {
    const identity = JSON.stringify(count);
    const countKey = key(identity);
    const previous = byKey.get(countKey);
    if (previous && previous.identity !== identity) invalid();
    byKey.set(countKey, { identity, value: 0 });
  }
  if (byKey.size > 0) {
    const rows = await sql<{
      count_key: string;
      identity: Count;
      value: string;
    }>`select count_key, identity, value::text
      from ${sql.table(counts)} where job_id = ${jobId}::uuid and count_key in (${sql.join([...byKey.keys()])})
      limit ${byKey.size}`.execute(db);
    for (const row of rows.rows) {
      const requestedCount = byKey.get(row.count_key);
      if (!requestedCount) return invalid();
      if (
        JSON.stringify(row.identity) !== requestedCount.identity ||
        !Number.isSafeInteger(Number(row.value)) ||
        Number(row.value) < 1
      )
        invalid();
      requestedCount.value = Number(row.value);
    }
  }
  return requested.map((count) => byKey.get(key(JSON.stringify(count)))!.value);
};

/** All-time movement starts at this metric's first nonempty UTC bucket. */
export const readPostgresInsightsFirstMovementBucket = async (
  db: QueryExecutorProvider,
  jobId: string,
  metric: InsightsMovementMetric,
): Promise<number | null> => {
  const row = (
    await sql<{ bucket_start_ms: string }>`
    select bucket_start_ms::text from ${sql.table(counts)}
    where job_id = ${jobId}::uuid and section = 'movementSeries' and metric = ${metric}
    order by ${sql.table(counts)}.bucket_start_ms limit 1`.execute(db)
  ).rows[0];
  if (row === undefined) return null;
  const value = Number(row.bucket_start_ms);
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
};

export const readPostgresInsightsSummary = async (
  db: QueryExecutorProvider,
  job: PostgresInsightsReportJob,
): Promise<PostgresInsightsReportSummary> => {
  const ids =
    job.query.kind === "bundleSummaries"
      ? job.query.bundleIds
      : job.query.kind === "bundleDetail"
        ? [job.query.bundleId]
        : null;
  const requested: Count[] =
    ids === null
      ? [["installations", "", "", -1]]
      : ids.flatMap((id): Count[] => [
          ["summary", "installed", id, -1],
          ["summary", "recovered", id, -1],
        ]);
  const values = await readPostgresInsightsReportCounts(db, job.id, requested);
  const byIdentity = new Map(
    requested.map((count, index) => [JSON.stringify(count), values[index]!]),
  );
  const value = (count: Count) => byIdentity.get(JSON.stringify(count))!;
  switch (job.query.kind) {
    case "bundleSummaries":
      return {
        kind: job.query.kind,
        summary: job.query.bundleIds.map((bundleId) => ({
          bundleId,
          installed: value(["summary", "installed", bundleId, -1]),
          recovered: value(["summary", "recovered", bundleId, -1]),
        })),
      };
    case "bundleDetail":
      return {
        kind: job.query.kind,
        summary: {
          installed: value(["summary", "installed", job.query.bundleId, -1]),
          recovered: value(["summary", "recovered", job.query.bundleId, -1]),
        },
      };
    case "installationOverview":
      return {
        kind: job.query.kind,
        summary: { trackedInstallations: value(["installations", "", "", -1]) },
      };
    case "activeOverview":
      return {
        kind: job.query.kind,
        summary: { activeInstallations: value(["installations", "", "", -1]) },
      };
  }
};
