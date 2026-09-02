import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsProjectedReadVersions,
  type InsightsPublication,
  type InsightsReportInput,
  type InsightsReportPage,
  type InsightsPublishedReportPageData,
  type InsightsReportPageInput,
  type InsightsReportPublication,
  type InsightsReportQuery,
  type InsightsReportResult,
} from "@hot-updater/plugin-core";
import {
  assertInsightsPageContract,
  assertInsightsQueryContract,
  createInsightsReportPageCursor,
  createInsightsReportProjection,
  readInsightsReportPageQuery,
  readInsightsReportQuery,
  type InsightsReportProjection,
} from "@hot-updater/plugin-core/internal";
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";

import type { SQLProvider as KyselySQLProvider } from "../../kysely";
import {
  KYSELY_INSIGHTS_INSTALLATION_WORK_ROWS,
  KYSELY_INSIGHTS_WORK_ROWS,
  tables,
} from "./constants";
import { readKyselyInsightsState } from "./source";
import {
  assertKyselyInsightsDatabaseNamespace,
  executeSerializable,
  insertIgnore,
  installationKey,
  lockRow,
  newOpaqueId,
  readRawEvent,
  sha256Hex,
  toSafeInteger,
} from "./utils";

type ReportPhase = "source" | "members" | "installations" | "order" | "publish";

type ReportJob = {
  id: string;
  query_hash: string;
  query_json: string;
  state: "queued" | "preparing" | "ready" | "failed";
  phase: ReportPhase;
  source_id: string;
  source_upper: unknown;
  as_of_ms: unknown;
  completed_at_ms: unknown | null;
  after_source_seq: unknown;
  after_member_key: string | null;
  after_install_key: string | null;
  order_phase: unknown;
  order_after_value: unknown | null;
  order_after_label: unknown | null;
  next_ordinal: unknown;
  publication_json: string | null;
  failure_json: string | null;
};

type StoredSource = { source_seq: unknown; raw_json: string };
type StoredMember = {
  member_key: string;
  section: string;
  metric: string;
  label: string;
  bucket_start_ms: unknown;
};
type StoredLatest = {
  install_key: string;
  bucket_index: unknown;
  received_at_ms: unknown;
  event_id: string;
  raw_json: string;
};
type StoredCount = {
  section: string;
  metric: string;
  label: string;
  label_order: unknown;
  bucket_start_ms: unknown;
  value: unknown;
};
type StoredOrder = {
  ordinal: unknown;
  label: string;
  label_ordinal: unknown;
  bucket_start_ms: unknown;
  value: unknown;
};

const reportVersions = (job: ReportJob): InsightsProjectedReadVersions => ({
  schemaVersion: "1.0.0",
  storageVersion: "kysely-insights-1",
  projectionGeneration: job.id,
  sourceGeneration: JSON.stringify([
    "kysely-insights-1",
    job.source_id,
    toSafeInteger(job.source_upper),
  ]),
});

const parseJob = (row: ReportJob | undefined): ReportJob => {
  if (!row) throw new DatabasePluginInputError("invalid-result");
  return row;
};

const parseQuery = (job: ReportJob): InsightsReportQuery => {
  try {
    return readInsightsReportQuery({
      query: JSON.parse(job.query_json),
    }).query;
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
};

const labelOrder = (value: string): Uint8Array => {
  const result = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    result[index * 2] = unit >>> 8;
    result[index * 2 + 1] = unit & 0xff;
  }
  return result;
};

const labelKey = (value: string): string => sha256Hex(JSON.stringify(value));

const toBucketInteger = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < -1) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return parsed;
};

const countIdentity = (
  section: string,
  metric: string,
  label: string,
  bucketStartMs: number,
): string => sha256Hex(JSON.stringify([section, metric, label, bucketStartMs]));

const memberIdentity = (
  section: string,
  metric: string,
  label: string,
  bucketStartMs: number,
  installId: string,
): string =>
  sha256Hex(JSON.stringify([section, metric, label, bucketStartMs, installId]));

const addMember = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  jobId: string,
  section: string,
  metric: string,
  label: string,
  bucketStartMs: number,
  installId: string,
): Promise<void> => {
  await insertIgnore(db, provider, tables.reportMembers, {
    job_id: jobId,
    member_key: memberIdentity(
      section,
      metric,
      label,
      bucketStartMs,
      installId,
    ),
    section,
    metric,
    label,
    bucket_start_ms: bucketStartMs,
  });
};

const incrementCount = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  jobId: string,
  section: string,
  metric: string,
  label: string,
  bucketStartMs: number,
): Promise<void> => {
  const key = countIdentity(section, metric, label, bucketStartMs);
  const order = labelOrder(label);
  const query =
    provider === "mysql"
      ? sql`insert into ${sql.table(tables.reportCounts)}
          (job_id, count_key, section, metric, label, label_order,
            bucket_start_ms, value)
          values (${jobId}, ${key}, ${section}, ${metric}, ${label}, ${order},
            ${bucketStartMs}, 1)
          on duplicate key update value = value + 1`
      : provider === "sqlite"
        ? sql`insert into ${sql.table(tables.reportCounts)}
            (job_id, count_key, section, metric, label, label_order,
              bucket_start_ms, value)
            values (${jobId}, ${key}, ${section}, ${metric}, ${label},
              ${order}, ${bucketStartMs}, 1)
            on conflict (job_id, count_key) do update set value = value + 1`
        : sql`insert into ${sql.table(tables.reportCounts)}
            (job_id, count_key, section, metric, label, label_order,
              bucket_start_ms, value)
            values (${jobId}, ${key}, ${section}, ${metric}, ${label},
              ${order}, ${bucketStartMs}, 1)
            on conflict (job_id, count_key) do update set value =
              ${sql.table(tables.reportCounts)}.value + 1`;
  await query.execute(db);
};

const saveLatest = async (
  db: QueryExecutorProvider,
  jobId: string,
  bucketIndex: number,
  event: BundleEventRow,
): Promise<void> => {
  const key = await installationKey(event.install_id);
  const rows = await sql<StoredLatest>`select install_key, bucket_index,
      received_at_ms, event_id, raw_json
    from ${sql.table(tables.reportLatest)} where job_id = ${jobId}
      and install_key = ${key} and bucket_index = ${bucketIndex}`.execute(db);
  const current = rows.rows[0];
  if (current) {
    const stored = readRawEvent(current.raw_json);
    if (stored.install_id !== event.install_id) {
      throw new DatabasePluginInputError("invalid-result");
    }
    const newer =
      event.received_at_ms > toSafeInteger(current.received_at_ms) ||
      (event.received_at_ms === toSafeInteger(current.received_at_ms) &&
        event.id > current.event_id);
    if (!newer) return;
    await sql`update ${sql.table(tables.reportLatest)} set
        received_at_ms = ${event.received_at_ms}, event_id = ${event.id},
        raw_json = ${JSON.stringify(event)}
      where job_id = ${jobId} and install_key = ${key}
        and bucket_index = ${bucketIndex}`.execute(db);
    return;
  }
  await sql`insert into ${sql.table(tables.reportLatest)}
    (job_id, install_key, bucket_index, received_at_ms, event_id, raw_json)
    values (${jobId}, ${key}, ${bucketIndex}, ${event.received_at_ms},
      ${event.id}, ${JSON.stringify(event)})`.execute(db);
};

const saveProjection = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  jobId: string,
  query: InsightsReportQuery,
  projection: InsightsReportProjection,
  firstBucketMs: number | null,
  bucketSizeMs: number,
): Promise<void> => {
  if (projection.kind === "movement") {
    await addMember(
      db,
      provider,
      jobId,
      "summary",
      projection.metric,
      projection.bundleId,
      -1,
      projection.installId,
    );
    await addMember(
      db,
      provider,
      jobId,
      "movementSeries",
      projection.metric,
      projection.bundleId,
      projection.bucketStartMs,
      projection.installId,
    );
    if (query.kind === "bundleDetail") {
      await addMember(
        db,
        provider,
        jobId,
        "movementCohorts",
        projection.metric,
        projection.cohort,
        -1,
        projection.installId,
      );
    }
    return;
  }
  await saveLatest(db, jobId, -1, projection.event);
  if (projection.bucketStartMs !== null) {
    const bucketIndex = Math.floor(
      (projection.bucketStartMs - firstBucketMs!) / bucketSizeMs,
    );
    await saveLatest(db, jobId, bucketIndex, projection.event);
  }
};

const reserveReport = async <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  databaseNamespace: string,
  input: InsightsReportInput,
): Promise<{ job: ReportJob; previous: ReportJob | null }> => {
  const canonical = readInsightsReportQuery(input);
  const hash = sha256Hex(
    JSON.stringify([1, "kysely-insights-1", canonical.semanticKey]),
  );
  return executeSerializable(db, provider, async (transaction) => {
    await insertIgnore(transaction, provider, tables.reportHeads, {
      query_hash: hash,
      query_json: JSON.stringify(canonical.query),
      active_job_id: null,
      publication_job_id: null,
      failed_job_id: null,
    });
    await lockRow(
      transaction,
      provider,
      tables.reportHeads,
      "query_hash",
      hash,
    );
    const head = await sql<{
      active_job_id: string | null;
      publication_job_id: string | null;
      failed_job_id: string | null;
    }>`select active_job_id, publication_job_id, failed_job_id from ${sql.table(
      tables.reportHeads,
    )} where query_hash = ${hash}`.execute(transaction);
    let previous: ReportJob | null = null;
    if (head.rows[0]?.publication_job_id) {
      const published = await sql<ReportJob>`select * from ${sql.table(
        tables.reportJobs,
      )} where id = ${head.rows[0].publication_job_id}`.execute(transaction);
      previous = parseJob(published.rows[0]);
      if (
        canonical.minAsOfMs === undefined ||
        toSafeInteger(previous.as_of_ms) >= canonical.minAsOfMs
      ) {
        return { job: previous, previous: null };
      }
    }
    if (head.rows[0]?.active_job_id) {
      const active = await sql<ReportJob>`select * from ${sql.table(
        tables.reportJobs,
      )} where id = ${head.rows[0].active_job_id}`.execute(transaction);
      return { job: parseJob(active.rows[0]), previous };
    }
    if (head.rows[0]?.failed_job_id) {
      const failed = await sql<ReportJob>`select * from ${sql.table(
        tables.reportJobs,
      )} where id = ${head.rows[0].failed_job_id}`.execute(transaction);
      return { job: parseJob(failed.rows[0]), previous };
    }
    const id = newOpaqueId();
    const source = await readKyselyInsightsState(
      transaction,
      databaseNamespace,
    );
    await sql`insert into ${sql.table(tables.reportJobs)} (
        id, query_hash, query_json, state, phase, source_id, source_upper,
        as_of_ms, completed_at_ms, after_source_seq, after_member_key,
        after_install_key, order_phase, order_after_value, order_after_label,
        next_ordinal, publication_json, failure_json
      ) values (
        ${id}, ${hash}, ${JSON.stringify(canonical.query)}, 'queued', 'source',
        ${source.sourceId}, ${source.upper}, ${Date.now()}, null, 0, null, null,
        0, null, null, 0, null, null
      )`.execute(transaction);
    await sql`update ${sql.table(tables.reportHeads)} set active_job_id = ${id}
      where query_hash = ${hash} and active_job_id is null`.execute(
      transaction,
    );
    const created = await sql<ReportJob>`select * from ${sql.table(
      tables.reportJobs,
    )} where id = ${id}`.execute(transaction);
    return { job: parseJob(created.rows[0]), previous };
  });
};

const stepSource = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  job: ReportJob,
  query: InsightsReportQuery,
  limit: number,
): Promise<number> => {
  const projection = createInsightsReportProjection(
    query,
    toSafeInteger(job.as_of_ms),
  );
  const rows = await sql<StoredSource>`select source_seq, raw_json
    from ${sql.table(tables.events)} where source_seq > ${toSafeInteger(
      job.after_source_seq,
    )} and source_seq <= ${toSafeInteger(job.source_upper)}
    order by source_seq limit ${limit}`.execute(db);
  for (const row of rows.rows) {
    const projected = projection.project(readRawEvent(row.raw_json));
    if (projected) {
      await saveProjection(
        db,
        provider,
        job.id,
        query,
        projected,
        projection.firstBucketMs,
        projection.bucketSizeMs,
      );
    }
  }
  const last = rows.rows.at(-1);
  const nextPhase =
    rows.rows.length === limit
      ? "source"
      : query.kind === "bundleSummaries" || query.kind === "bundleDetail"
        ? "members"
        : "installations";
  await sql`update ${sql.table(tables.reportJobs)} set state = 'preparing',
      phase = ${nextPhase},
      after_source_seq = ${last ? toSafeInteger(last.source_seq) : toSafeInteger(job.after_source_seq)}
    where id = ${job.id}`.execute(db);
  return rows.rows.length;
};

const stepMembers = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  job: ReportJob,
  limit: number,
): Promise<number> => {
  const rows = await sql<StoredMember>`select member_key, section, metric,
      label, bucket_start_ms from ${sql.table(tables.reportMembers)}
    where job_id = ${job.id}
      ${job.after_member_key ? sql`and member_key > ${job.after_member_key}` : sql``}
    order by member_key limit ${limit}`.execute(db);
  for (const member of rows.rows) {
    await incrementCount(
      db,
      provider,
      job.id,
      member.section,
      member.metric,
      member.label,
      Number(member.bucket_start_ms),
    );
  }
  const last = rows.rows.at(-1);
  await sql`update ${sql.table(tables.reportJobs)} set
      phase = ${rows.rows.length === limit ? "members" : "order"},
      after_member_key = ${last?.member_key ?? job.after_member_key}
    where id = ${job.id}`.execute(db);
  return rows.rows.length;
};

const stepInstallations = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  job: ReportJob,
  query: Extract<
    InsightsReportQuery,
    { kind: "installationOverview" | "activeOverview" }
  >,
  limit: number,
): Promise<number> => {
  const rows = await sql<StoredLatest>`select install_key, bucket_index,
      received_at_ms, event_id, raw_json
    from ${sql.table(tables.reportLatest)} where job_id = ${job.id}
      and bucket_index = -1
      ${job.after_install_key ? sql`and install_key > ${job.after_install_key}` : sql``}
    order by install_key limit ${limit}`.execute(db);
  for (const row of rows.rows) {
    const latest = readRawEvent(row.raw_json);
    if ((await installationKey(latest.install_id)) !== row.install_key) {
      throw new DatabasePluginInputError("invalid-result");
    }
    if (query.kind === "installationOverview") {
      await incrementCount(db, provider, job.id, "summary", "", "", -1);
      await incrementCount(
        db,
        provider,
        job.id,
        "bundleDistribution",
        "",
        latest.to_bundle_id,
        -1,
      );
      continue;
    }
    if (query.userId !== undefined && latest.user_id !== query.userId) continue;
    await incrementCount(db, provider, job.id, "summary", "", "", -1);
    await incrementCount(
      db,
      provider,
      job.id,
      "bundleDistribution",
      "",
      latest.to_bundle_id,
      -1,
    );
    const buckets = await sql<StoredLatest>`select install_key, bucket_index,
        received_at_ms, event_id, raw_json
      from ${sql.table(tables.reportLatest)} where job_id = ${job.id}
        and install_key = ${row.install_key} and bucket_index >= 0
      order by bucket_index`.execute(db);
    const reportProjection = createInsightsReportProjection(
      query,
      toSafeInteger(job.as_of_ms),
    );
    for (const bucket of buckets.rows) {
      const event = readRawEvent(bucket.raw_json);
      const bucketStartMs =
        reportProjection.firstBucketMs! +
        toSafeInteger(bucket.bucket_index) * reportProjection.bucketSizeMs;
      await incrementCount(
        db,
        provider,
        job.id,
        "activeSeries",
        "",
        "",
        bucketStartMs,
      );
      await incrementCount(
        db,
        provider,
        job.id,
        "activeBundleSeries",
        "",
        event.to_bundle_id,
        bucketStartMs,
      );
      await incrementCount(
        db,
        provider,
        job.id,
        "activeBundleTotals",
        "",
        event.to_bundle_id,
        -1,
      );
    }
  }
  const last = rows.rows.at(-1);
  await sql`update ${sql.table(tables.reportJobs)} set
      phase = ${rows.rows.length === limit ? "installations" : "order"},
      after_install_key = ${last?.install_key ?? job.after_install_key}
    where id = ${job.id}`.execute(db);
  return rows.rows.length;
};

type OrderSection =
  | {
      readonly mode: "rank";
      readonly kind: "movementCohorts" | "bundleDistribution";
      readonly metric: string;
      readonly order: "label" | "value";
    }
  | {
      readonly mode: "series";
      readonly kind: "movementSeries" | "activeSeries";
      readonly metric: string;
    }
  | {
      readonly mode: "bundleSeries";
      readonly kind: "activeBundleSeries";
      readonly metric: string;
    };

const orderSections = (query: InsightsReportQuery): readonly OrderSection[] => {
  switch (query.kind) {
    case "bundleSummaries":
      return [];
    case "bundleDetail":
      return [
        { mode: "series", kind: "movementSeries", metric: "installed" },
        { mode: "series", kind: "movementSeries", metric: "recovered" },
        {
          mode: "rank",
          kind: "movementCohorts",
          metric: "installed",
          order: "label",
        },
        {
          mode: "rank",
          kind: "movementCohorts",
          metric: "recovered",
          order: "label",
        },
      ];
    case "installationOverview":
      return [
        {
          mode: "rank",
          kind: "bundleDistribution",
          metric: "",
          order: "value",
        },
      ];
    case "activeOverview":
      return [
        { mode: "series", kind: "activeSeries", metric: "" },
        { mode: "bundleSeries", kind: "activeBundleSeries", metric: "" },
        {
          mode: "rank",
          kind: "bundleDistribution",
          metric: "",
          order: "value",
        },
      ];
  }
};

const readPageTotal = async (
  db: QueryExecutorProvider,
  jobId: string,
  section: string,
  metric: string,
  label: string,
): Promise<number> => {
  const key = labelKey(label);
  const result = await sql<{ label: string; total: unknown }>`select label,
      total from ${sql.table(tables.reportPageTotals)} where job_id = ${jobId}
      and section = ${section} and metric = ${metric}
      and label_key = ${key}`.execute(db);
  const stored = result.rows[0];
  if (!stored) return 0;
  if (stored.label !== label) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return toSafeInteger(stored.total);
};

const savePageTotal = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  jobId: string,
  section: string,
  metric: string,
  label: string,
  total: number,
): Promise<void> => {
  const key = labelKey(label);
  const query =
    provider === "mysql"
      ? sql`insert into ${sql.table(tables.reportPageTotals)}
          (job_id, section, metric, label, label_key, total)
          values (${jobId}, ${section}, ${metric}, ${label}, ${key}, ${total})
          on duplicate key update label = values(label), total = values(total)`
      : sql`insert into ${sql.table(tables.reportPageTotals)}
          (job_id, section, metric, label, label_key, total)
          values (${jobId}, ${section}, ${metric}, ${label}, ${key}, ${total})
          on conflict (job_id, section, metric, label_key) do update set
            label = excluded.label, total = excluded.total`;
  await query.execute(db);
};

const insertOrderRow = async (
  db: QueryExecutorProvider,
  job: ReportJob,
  section: OrderSection,
  ordinal: number,
  labelOrdinal: number,
  row: StoredCount,
): Promise<void> => {
  await sql`insert into ${sql.table(tables.reportOrder)}
    (job_id, order_kind, metric, ordinal, label, label_key, label_ordinal,
      bucket_start_ms, value)
    values (${job.id}, ${section.kind}, ${section.metric}, ${ordinal},
      ${row.label}, ${labelKey(row.label)}, ${labelOrdinal},
      ${toBucketInteger(row.bucket_start_ms)}, ${toSafeInteger(row.value)})`.execute(
    db,
  );
};

const stepRankOrder = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  job: ReportJob,
  section: Extract<OrderSection, { readonly mode: "rank" }>,
  limit: number,
): Promise<{ readonly complete: boolean; readonly processed: number }> => {
  const after =
    job.order_after_label === null
      ? sql``
      : section.order === "value"
        ? sql`and (value < ${toSafeInteger(job.order_after_value)}
            or (value = ${toSafeInteger(job.order_after_value)}
              and label_order > ${job.order_after_label}))`
        : sql`and label_order > ${job.order_after_label}`;
  const order =
    section.order === "value"
      ? sql`value desc, label_order asc`
      : sql`label_order asc`;
  const rows = await sql<StoredCount>`select section, metric, label,
      label_order, bucket_start_ms, value from ${sql.table(tables.reportCounts)}
    where job_id = ${job.id} and section = ${section.kind}
      and metric = ${section.metric} and bucket_start_ms = -1 ${after}
    order by ${order} limit ${limit}`.execute(db);
  let ordinal = toSafeInteger(job.next_ordinal);
  for (const row of rows.rows) {
    await insertOrderRow(db, job, section, ordinal, ordinal, row);
    ordinal += 1;
  }
  const last = rows.rows.at(-1);
  if (rows.rows.length === limit && last) {
    await sql`update ${sql.table(tables.reportJobs)} set
        order_after_value = ${section.order === "value" ? toSafeInteger(last.value) : null},
        order_after_label = ${last.label_order},
        next_ordinal = ${ordinal}
      where id = ${job.id}`.execute(db);
    return { complete: false, processed: rows.rows.length };
  }
  await savePageTotal(
    db,
    provider,
    job.id,
    section.kind,
    section.metric,
    "",
    ordinal,
  );
  return { complete: true, processed: rows.rows.length };
};

const stepSeriesOrder = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  job: ReportJob,
  query: InsightsReportQuery,
  section: Extract<OrderSection, { readonly mode: "series" }>,
  limit: number,
): Promise<{ readonly complete: boolean; readonly processed: number }> => {
  const projection = createInsightsReportProjection(
    query,
    toSafeInteger(job.as_of_ms),
  );
  let firstBucketMs = projection.firstBucketMs;
  if (firstBucketMs === null) {
    const first = await sql<{ bucket_start_ms: unknown }>`select bucket_start_ms
      from ${sql.table(tables.reportCounts)} where job_id = ${job.id}
        and section = ${section.kind} and metric = ${section.metric}
        and bucket_start_ms >= 0 order by bucket_start_ms, label_order
        limit 1`.execute(db);
    firstBucketMs = first.rows[0]
      ? toBucketInteger(first.rows[0].bucket_start_ms)
      : projection.lastBucketMs;
  }
  const nextBucketMs =
    job.order_after_value === null
      ? firstBucketMs
      : toSafeInteger(job.order_after_value) + projection.bucketSizeMs;
  if (nextBucketMs > projection.lastBucketMs) {
    await savePageTotal(
      db,
      provider,
      job.id,
      section.kind,
      section.metric,
      "",
      toSafeInteger(job.next_ordinal),
    );
    return { complete: true, processed: 0 };
  }
  const count = Math.min(
    limit,
    Math.floor(
      (projection.lastBucketMs - nextBucketMs) / projection.bucketSizeMs,
    ) + 1,
  );
  const bucketStartMs = Array.from(
    { length: count },
    (_, index) => nextBucketMs + index * projection.bucketSizeMs,
  );
  const seriesLabel =
    section.kind === "movementSeries" && query.kind === "bundleDetail"
      ? query.bundleId
      : "";
  const values = await readCounts(
    db,
    job.id,
    bucketStartMs.map((bucket) => ({
      section: section.kind,
      metric: section.metric,
      label: seriesLabel,
      bucketStartMs: bucket,
    })),
  );
  let ordinal = toSafeInteger(job.next_ordinal);
  for (const [index, bucket] of bucketStartMs.entries()) {
    await insertOrderRow(db, job, section, ordinal, ordinal, {
      section: section.kind,
      metric: section.metric,
      label: seriesLabel,
      label_order: labelOrder(seriesLabel),
      bucket_start_ms: bucket,
      value: values[index] ?? 0,
    });
    ordinal += 1;
  }
  const lastBucketMs = bucketStartMs.at(-1)!;
  if (lastBucketMs < projection.lastBucketMs) {
    await sql`update ${sql.table(tables.reportJobs)} set
        order_after_value = ${lastBucketMs}, order_after_label = null,
        next_ordinal = ${ordinal} where id = ${job.id}`.execute(db);
    return { complete: false, processed: count };
  }
  await savePageTotal(
    db,
    provider,
    job.id,
    section.kind,
    section.metric,
    "",
    ordinal,
  );
  return { complete: true, processed: count };
};

const stepBundleSeriesOrder = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  job: ReportJob,
  query: Extract<InsightsReportQuery, { readonly kind: "activeOverview" }>,
  section: Extract<OrderSection, { readonly mode: "bundleSeries" }>,
  limit: number,
): Promise<{ readonly complete: boolean; readonly processed: number }> => {
  const projection = createInsightsReportProjection(
    query,
    toSafeInteger(job.as_of_ms),
  );
  const firstBucketMs = projection.firstBucketMs!;
  const bucketCount =
    (projection.lastBucketMs - firstBucketMs) / projection.bucketSizeMs + 1;
  const after =
    job.order_after_label === null
      ? sql``
      : sql`and (value < ${toSafeInteger(job.order_after_value)}
          or (value = ${toSafeInteger(job.order_after_value)}
            and label_order > ${job.order_after_label}))`;
  const labels = await sql<StoredCount>`select section, metric, label,
      label_order, bucket_start_ms, value from ${sql.table(tables.reportCounts)}
    where job_id = ${job.id} and section = 'activeBundleTotals'
      and metric = '' and bucket_start_ms = -1 ${after}
    order by value desc, label_order asc limit 1`.execute(db);
  const label = labels.rows[0];
  if (!label) {
    await savePageTotal(
      db,
      provider,
      job.id,
      section.kind,
      section.metric,
      "",
      toSafeInteger(job.next_ordinal),
    );
    return { complete: true, processed: 0 };
  }
  const nextOrdinal = toSafeInteger(job.next_ordinal);
  const firstLabelOrdinal = nextOrdinal % bucketCount;
  const count = Math.min(limit, bucketCount - firstLabelOrdinal);
  const buckets = Array.from(
    { length: count },
    (_, index) =>
      firstBucketMs + (firstLabelOrdinal + index) * projection.bucketSizeMs,
  );
  const values = await readCounts(
    db,
    job.id,
    buckets.map((bucketStartMs) => ({
      section: section.kind,
      metric: section.metric,
      label: label.label,
      bucketStartMs,
    })),
  );
  let ordinal = nextOrdinal;
  for (const [offset, bucketStartMs] of buckets.entries()) {
    await insertOrderRow(
      db,
      job,
      section,
      ordinal,
      firstLabelOrdinal + offset,
      {
        section: section.kind,
        metric: section.metric,
        label: label.label,
        label_order: label.label_order,
        bucket_start_ms: bucketStartMs,
        value: values[offset] ?? 0,
      },
    );
    ordinal += 1;
  }
  if (firstLabelOrdinal + count < bucketCount) {
    await sql`update ${sql.table(tables.reportJobs)} set
        next_ordinal = ${ordinal} where id = ${job.id}`.execute(db);
    return { complete: false, processed: count };
  }
  await savePageTotal(
    db,
    provider,
    job.id,
    section.kind,
    section.metric,
    label.label,
    bucketCount,
  );
  await sql`update ${sql.table(tables.reportJobs)} set
      order_after_value = ${toSafeInteger(label.value)},
      order_after_label = ${label.label_order}, next_ordinal = ${ordinal}
    where id = ${job.id}`.execute(db);
  return { complete: false, processed: count };
};

const stepOrder = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  job: ReportJob,
  query: InsightsReportQuery,
  limit: number,
): Promise<number> => {
  const sections = orderSections(query);
  const phase = toSafeInteger(job.order_phase);
  if (phase >= sections.length) {
    await sql`update ${sql.table(tables.reportJobs)} set phase = 'publish'
      where id = ${job.id}`.execute(db);
    return 0;
  }
  const section = sections[phase]!;
  const result =
    section.mode === "rank"
      ? await stepRankOrder(db, provider, job, section, limit)
      : section.mode === "series"
        ? await stepSeriesOrder(db, provider, job, query, section, limit)
        : query.kind === "activeOverview"
          ? await stepBundleSeriesOrder(
              db,
              provider,
              job,
              query,
              section,
              limit,
            )
          : (() => {
              throw new DatabasePluginInputError("invalid-result");
            })();
  if (!result.complete) return result.processed;
  await sql`update ${sql.table(tables.reportJobs)} set
      order_phase = ${phase + 1}, order_after_value = null,
      order_after_label = null, next_ordinal = 0,
      phase = ${phase + 1 >= sections.length ? "publish" : "order"}
    where id = ${job.id}`.execute(db);
  return result.processed;
};

const reportPublication = async (
  db: QueryExecutorProvider,
  job: ReportJob,
  query: InsightsReportQuery,
  completedAtMs: number,
): Promise<InsightsReportPublication> => {
  const base: InsightsPublication = {
    id: job.id,
    asOfMs: toSafeInteger(job.as_of_ms),
    completedAtMs,
    sourceGeneration: reportVersions(job).sourceGeneration,
    accuracy: "exact",
  };
  switch (query.kind) {
    case "bundleSummaries": {
      const counts = await readCounts(
        db,
        job.id,
        query.bundleIds.flatMap((bundleId) => [
          {
            section: "summary",
            metric: "installed",
            label: bundleId,
            bucketStartMs: -1,
          },
          {
            section: "summary",
            metric: "recovered",
            label: bundleId,
            bucketStartMs: -1,
          },
        ]),
      );
      return {
        ...base,
        kind: query.kind,
        summary: query.bundleIds.map((bundleId, index) => ({
          bundleId,
          installed: counts[index * 2] ?? 0,
          recovered: counts[index * 2 + 1] ?? 0,
        })),
      };
    }
    case "bundleDetail": {
      const counts = await readCounts(db, job.id, [
        {
          section: "summary",
          metric: "installed",
          label: query.bundleId,
          bucketStartMs: -1,
        },
        {
          section: "summary",
          metric: "recovered",
          label: query.bundleId,
          bucketStartMs: -1,
        },
      ]);
      return {
        ...base,
        kind: query.kind,
        summary: {
          installed: counts[0] ?? 0,
          recovered: counts[1] ?? 0,
        },
      };
    }
    case "installationOverview": {
      const counts = await readCounts(db, job.id, [
        {
          section: "summary",
          metric: "",
          label: "",
          bucketStartMs: -1,
        },
      ]);
      return {
        ...base,
        kind: query.kind,
        summary: { trackedInstallations: counts[0] ?? 0 },
      };
    }
    case "activeOverview": {
      const counts = await readCounts(db, job.id, [
        {
          section: "summary",
          metric: "",
          label: "",
          bucketStartMs: -1,
        },
      ]);
      return {
        ...base,
        kind: query.kind,
        summary: { activeInstallations: counts[0] ?? 0 },
      };
    }
  }
};

const publishReport = async (
  db: QueryExecutorProvider,
  job: ReportJob,
  query: InsightsReportQuery,
): Promise<void> => {
  const completedAtMs = Date.now();
  const publication = await reportPublication(db, job, query, completedAtMs);
  await sql`update ${sql.table(tables.reportJobs)} set state = 'ready',
      completed_at_ms = ${completedAtMs},
      publication_json = ${JSON.stringify(publication)} where id = ${job.id}`.execute(
    db,
  );
  await sql`update ${sql.table(tables.reportHeads)} set
      active_job_id = null, publication_job_id = ${job.id},
      failed_job_id = null
    where query_hash = ${job.query_hash} and active_job_id = ${job.id}`.execute(
    db,
  );
};

export const stepKyselyInsightsReport = async <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  jobId: string,
  input: { readonly maxItems: number; readonly maxRequests: number },
): Promise<{
  readonly job: ReportJob;
  readonly advanced: boolean;
  readonly processed: number;
}> =>
  executeSerializable(db, provider, async (transaction) => {
    await lockRow(transaction, provider, tables.reportJobs, "id", jobId);
    const result = await sql<ReportJob>`select * from ${sql.table(
      tables.reportJobs,
    )} where id = ${jobId}`.execute(transaction);
    const job = parseJob(result.rows[0]);
    if (job.state === "ready" || job.state === "failed") {
      return { job, advanced: false, processed: 0 };
    }
    if (
      (job.phase === "publish" && input.maxRequests < 10) ||
      (job.phase === "installations" && input.maxRequests < 103)
    ) {
      return { job, advanced: false, processed: 0 };
    }
    const query = parseQuery(job);
    const regularLimit = Math.max(
      1,
      Math.min(
        KYSELY_INSIGHTS_WORK_ROWS,
        input.maxItems,
        Math.floor((input.maxRequests - 8) / 8),
      ),
    );
    const installationLimit = Math.max(
      1,
      Math.min(
        KYSELY_INSIGHTS_INSTALLATION_WORK_ROWS,
        input.maxItems,
        Math.floor((input.maxRequests - 8) / 95),
      ),
    );
    let processed = 0;
    try {
      switch (job.phase) {
        case "source":
          processed = await stepSource(
            transaction,
            provider,
            job,
            query,
            regularLimit,
          );
          break;
        case "members":
          processed = await stepMembers(
            transaction,
            provider,
            job,
            regularLimit,
          );
          break;
        case "installations":
          if (
            query.kind !== "installationOverview" &&
            query.kind !== "activeOverview"
          ) {
            throw new DatabasePluginInputError("invalid-result");
          }
          processed = await stepInstallations(
            transaction,
            provider,
            job,
            query,
            installationLimit,
          );
          break;
        case "order":
          processed = await stepOrder(
            transaction,
            provider,
            job,
            query,
            regularLimit,
          );
          break;
        case "publish":
          await publishReport(transaction, job, query);
          break;
      }
    } catch (error) {
      if (!(error instanceof DatabasePluginInputError)) throw error;
      const code =
        job.phase === "source" ? "migration-poison" : "preparation-failed";
      const failureJson = JSON.stringify({ code });
      await sql`update ${sql.table(tables.reportJobs)} set state = 'failed',
          failure_json = ${failureJson}
        where id = ${job.id} and state in ('queued', 'preparing')`.execute(
        transaction,
      );
      await sql`update ${sql.table(tables.reportHeads)} set
          active_job_id = null, failed_job_id = ${job.id}
        where query_hash = ${job.query_hash}
          and active_job_id = ${job.id}`.execute(transaction);
      return {
        job: { ...job, state: "failed", failure_json: failureJson },
        advanced: true,
        processed,
      };
    }
    const updated = await sql<ReportJob>`select * from ${sql.table(
      tables.reportJobs,
    )} where id = ${job.id}`.execute(transaction);
    return { job: parseJob(updated.rows[0]), advanced: true, processed };
  });

export const failKyselyInsightsReport = async <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  job: ReportJob,
): Promise<ReportJob> =>
  executeSerializable(db, provider, async (transaction) => {
    await lockRow(transaction, provider, tables.reportJobs, "id", job.id);
    await sql`update ${sql.table(tables.reportJobs)} set state = 'failed',
        failure_json = ${JSON.stringify({ code: "preparation-failed" })}
      where id = ${job.id} and state in ('queued', 'preparing')`.execute(
      transaction,
    );
    await sql`update ${sql.table(tables.reportHeads)} set active_job_id = null,
        failed_job_id = ${job.id}
      where query_hash = ${job.query_hash} and active_job_id = ${job.id}`.execute(
      transaction,
    );
    const result = await sql<ReportJob>`select * from ${sql.table(
      tables.reportJobs,
    )} where id = ${job.id}`.execute(transaction);
    return parseJob(result.rows[0]);
  });

const readPublication = (job: ReportJob): InsightsReportPublication => {
  if (!job.publication_json) {
    throw new DatabasePluginInputError("invalid-result");
  }
  try {
    return JSON.parse(job.publication_json) as InsightsReportPublication;
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
};

const reportFailureCode = (
  job: ReportJob,
): "migration-poison" | "preparation-failed" => {
  try {
    const failure: unknown = JSON.parse(job.failure_json ?? "null");
    return typeof failure === "object" &&
      failure !== null &&
      Reflect.get(failure, "code") === "migration-poison"
      ? "migration-poison"
      : "preparation-failed";
  } catch {
    return "preparation-failed";
  }
};

export const getKyselyInsightsReport = async <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  databaseNamespace: string,
  input: InsightsReportInput,
): Promise<InsightsReportResult> => {
  assertKyselyInsightsDatabaseNamespace(databaseNamespace);
  assertInsightsQueryContract(input);
  try {
    const reservation = await reserveReport(
      db,
      provider,
      databaseNamespace,
      input,
    );
    const job = reservation.job;
    if (
      job.source_id !== databaseNamespace ||
      (reservation.previous !== null &&
        reservation.previous.source_id !== databaseNamespace)
    ) {
      throw new DatabasePluginInputError("invalid-result");
    }
    const currentVersions = reportVersions(job);
    if (job.state === "ready") {
      const result = {
        state: "ready" as const,
        versions: currentVersions,
        data: readPublication(job),
      };
      return result;
    }
    if (job.state === "failed") {
      return {
        state: "failed",
        versions: currentVersions,
        error: { code: reportFailureCode(job), jobId: job.id },
      };
    }
    if (reservation.previous) {
      return {
        state: "stale",
        versions: reportVersions(reservation.previous),
        data: readPublication(reservation.previous),
        refresh: { id: job.id },
      };
    }
    return {
      state: "preparing",
      versions: currentVersions,
      job: { id: job.id },
    };
  } catch (error) {
    if (!(error instanceof InsightsQueryNotReadyError)) throw error;
    return {
      state: "failed",
      versions: {
        schemaVersion: "1.0.0",
        storageVersion: "kysely-insights-1",
        projectionGeneration: null,
        sourceGeneration: null,
      },
      error: { code: "source-not-ready" },
    };
  }
};

const requireSection = (
  query: InsightsReportQuery,
  request: ReturnType<typeof readInsightsReportPageQuery>["input"],
): void => {
  switch (request.section) {
    case "movementSeries":
    case "movementCohorts":
      if (query.kind !== "bundleDetail") {
        throw new DatabasePluginInputError("invalid-query");
      }
      return;
    case "bundleDistribution":
      if (
        query.kind !== "installationOverview" &&
        query.kind !== "activeOverview"
      ) {
        throw new DatabasePluginInputError("invalid-query");
      }
      return;
    case "activeSeries":
    case "activeBundleSeries":
      if (query.kind !== "activeOverview") {
        throw new DatabasePluginInputError("invalid-query");
      }
  }
};

const readCounts = async (
  db: QueryExecutorProvider,
  jobId: string,
  identities: readonly {
    section: string;
    metric: string;
    label: string;
    bucketStartMs: number;
  }[],
): Promise<readonly number[]> => {
  if (identities.length === 0) return [];
  const keys = identities.map((identity) =>
    countIdentity(
      identity.section,
      identity.metric,
      identity.label,
      identity.bucketStartMs,
    ),
  );
  const result = await sql<{ count_key: string; value: unknown }>`select
      count_key, value from ${sql.table(tables.reportCounts)}
    where job_id = ${jobId} and count_key in (${sql.join(keys)})`.execute(db);
  const values = new Map(
    result.rows.map((row) => [row.count_key, toSafeInteger(row.value)]),
  );
  return keys.map((key) => values.get(key) ?? 0);
};

const pageBounds = (
  input: InsightsReportPageInput,
  start: bigint,
  total: bigint,
  databaseNamespace: string,
): { size: number; nextCursor: string | null } => {
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

const pageOrder = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  job: ReportJob,
  input: InsightsReportPageInput,
  kind: string,
  metric: string,
  start: bigint,
  label?: string,
): Promise<{
  rows: readonly StoredOrder[];
  total: bigint;
  nextCursor: string | null;
}> => {
  const total = BigInt(
    await readPageTotal(db, job.id, kind, metric, label ?? ""),
  );
  const bounds = pageBounds(input, start, total, job.source_id);
  if (bounds.size === 0) {
    return { rows: [], total, nextCursor: bounds.nextCursor };
  }
  const rows = label
    ? (
        await sql<StoredOrder>`select ordinal, label, label_ordinal,
            bucket_start_ms, value from ${sql.table(tables.reportOrder)}
          where job_id = ${job.id} and order_kind = ${kind}
            and metric = ${metric} and label_key = ${labelKey(label)}
            and label_ordinal >= ${start.toString()}
          order by label_ordinal limit ${bounds.size}`.execute(db)
      ).rows
    : (
        await sql<StoredOrder>`select ordinal, label, label_ordinal,
            bucket_start_ms, value from ${sql.table(tables.reportOrder)}
          ${provider === "mysql" ? sql`force index (primary)` : sql``}
          where job_id = ${job.id} and order_kind = ${kind}
            and metric = ${metric} and ordinal >= ${start.toString()}
          order by ordinal limit ${bounds.size}`.execute(db)
      ).rows;
  if (label !== undefined && rows.some((row) => row.label !== label)) {
    throw new DatabasePluginInputError("invalid-result");
  }
  if (rows.length !== bounds.size) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return { rows, total, nextCursor: bounds.nextCursor };
};

export const pageKyselyInsightsReport = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  databaseNamespace: string,
  input: InsightsReportPageInput,
): Promise<InsightsReportPage> => {
  assertKyselyInsightsDatabaseNamespace(databaseNamespace);
  const parsed = readInsightsReportPageQuery(input, databaseNamespace);
  if (input.cursor !== undefined) {
    await readKyselyInsightsState(db, databaseNamespace);
  }
  const jobs = await sql<ReportJob>`select * from ${sql.table(
    tables.reportJobs,
  )} where id = ${input.publicationId}`.execute(db);
  const job = jobs.rows[0];
  if (!job) return { state: "expired", publicationId: input.publicationId };
  if (job.source_id !== databaseNamespace) {
    throw new DatabasePluginInputError("invalid-result");
  }
  if (job.state !== "ready") {
    return {
      state: "failed",
      versions: reportVersions(job),
      error: { code: "index-not-ready" },
    };
  }
  const query = parseQuery(job);
  requireSection(query, parsed.input);
  const start = BigInt(parsed.nextOrdinal);
  const report = readPublication(job);
  const publication: InsightsPublication = {
    id: report.id,
    asOfMs: report.asOfMs,
    completedAtMs: report.completedAtMs,
    sourceGeneration: report.sourceGeneration,
    accuracy: report.accuracy,
  };
  const consistency = {
    kind: "snapshot" as const,
    cutoff: { kind: "publication" as const, publication },
  };
  let data: InsightsPublishedReportPageData;

  switch (parsed.input.section) {
    case "movementCohorts": {
      const page = await pageOrder(
        db,
        provider,
        job,
        input,
        "movementCohorts",
        parsed.input.metric,
        start,
      );
      data = {
        section: parsed.input.section,
        metric: parsed.input.metric,
        data: page.rows.map((row) => ({
          cohort: row.label,
          value: toSafeInteger(row.value),
        })),
        nextCursor: page.nextCursor,
        hasNext: page.nextCursor !== null,
        consistency,
        total: {
          state: "exact",
          value: Number(page.total),
          sourceGeneration: publication.sourceGeneration,
        },
      } as typeof data;
      break;
    }
    case "bundleDistribution": {
      const page = await pageOrder(
        db,
        provider,
        job,
        input,
        "bundleDistribution",
        "",
        start,
      );
      data = {
        section: parsed.input.section,
        data: page.rows.map((row) => ({
          bundleId: row.label,
          installations: toSafeInteger(row.value),
        })),
        nextCursor: page.nextCursor,
        hasNext: page.nextCursor !== null,
        consistency,
        total: {
          state: "exact",
          value: Number(page.total),
          sourceGeneration: publication.sourceGeneration,
        },
      } as typeof data;
      break;
    }
    case "movementSeries":
    case "activeSeries": {
      const page = await pageOrder(
        db,
        provider,
        job,
        input,
        parsed.input.section,
        parsed.input.section === "movementSeries" ? parsed.input.metric : "",
        start,
      );
      const common = {
        data: page.rows.map((row) => ({
          bucketStartMs: toSafeInteger(row.bucket_start_ms),
          value: toSafeInteger(row.value),
        })),
        nextCursor: page.nextCursor,
        hasNext: page.nextCursor !== null,
        consistency,
        total: {
          state: "exact" as const,
          value: Number(page.total),
          sourceGeneration: publication.sourceGeneration,
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
      ) as typeof data;
      break;
    }
    case "activeBundleSeries": {
      const requestedBundleId = parsed.input.bundleId;
      const page = await pageOrder(
        db,
        provider,
        job,
        input,
        "activeBundleSeries",
        "",
        start,
        requestedBundleId,
      );
      data = {
        section: parsed.input.section,
        data: page.rows.map((row) => ({
          bundleId: row.label,
          bucketStartMs: toSafeInteger(row.bucket_start_ms),
          value: toSafeInteger(row.value),
        })),
        nextCursor: page.nextCursor,
        hasNext: page.nextCursor !== null,
        consistency,
        total: {
          state: "exact",
          value: Number(page.total),
          sourceGeneration: publication.sourceGeneration,
        },
      } as typeof data;
      break;
    }
  }
  const result = {
    state: "ready" as const,
    versions: reportVersions(job),
    data,
  };
  assertInsightsPageContract(result, input.limit);
  return result;
};
