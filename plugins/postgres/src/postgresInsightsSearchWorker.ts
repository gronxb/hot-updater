import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import { sql, type Transaction } from "kysely";

import { readPostgresInsightsAliasPage } from "./postgresInsightsAliases";
import { assertPostgresInsightsStoredEvent } from "./postgresInsightsContract";
import {
  isPostgresInsightsContainsJob,
  type createPostgresInsightsJobs,
  type PostgresInsightsContainsJob,
  type PostgresInsightsReportLeaseToken,
} from "./postgresInsightsJobs";
import { readPostgresInsightsLatestByKey } from "./postgresInsightsReportData";
import {
  getPostgresInsightsReportOrderReady,
  stepPostgresInsightsReportOrder,
} from "./postgresInsightsReportOrder";

const section = { section: "installationIds" } as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = (identity: string) =>
  createHash("sha256").update(identity).digest("hex");
const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};

/** Saves one set entry per matching installation in the worker transaction. */
export const savePostgresInsightsSearchMatches = async <TDatabase>(
  db: Transaction<TDatabase>,
  jobId: string,
  matches: readonly { installKey: string; event: BundleEventRow }[],
): Promise<void> => {
  if (
    !db.isTransaction ||
    typeof jobId !== "string" ||
    !uuid.test(jobId) ||
    !Array.isArray(matches) ||
    matches.length > 200
  )
    throw new DatabasePluginInputError("invalid-query");
  const expected = new Map<string, { identity: string; installId: string }>();
  for (const row of matches) {
    if (typeof row !== "object" || row === null) invalid();
    assertPostgresInsightsStoredEvent(row.event);
    if (row.installKey !== hash(JSON.stringify(row.event.install_id)))
      invalid();
    const identity = JSON.stringify([
      "installationIds",
      "",
      row.event.install_id,
      -1,
    ]);
    const prior = expected.get(row.installKey);
    if (prior !== undefined && prior.identity !== identity) invalid();
    expected.set(row.installKey, {
      identity,
      installId: row.event.install_id,
    });
  }
  if (expected.size === 0) return;
  await sql`with input(count_key,identity,install_id) as (values ${sql.join(
    [...expected].map(
      ([key, { identity, installId }]) =>
        sql`(${key}::text,${identity}::jsonb,${installId}::text)`,
    ),
  )}), manifest as (
    insert into private_hot_updater_insights_report_count_manifest
      (job_id,count_key,identity,section,metric,label,bucket_start_ms)
      select ${jobId}::uuid,count_key,identity,'installationIds','',install_id,-1
        from input
    on conflict (job_id,count_key) do update set count_key=excluded.count_key
      where private_hot_updater_insights_report_count_manifest.identity=excluded.identity
        and private_hot_updater_insights_report_count_manifest.section=excluded.section
        and private_hot_updater_insights_report_count_manifest.metric=excluded.metric
        and private_hot_updater_insights_report_count_manifest.label=excluded.label
        and private_hot_updater_insights_report_count_manifest.bucket_start_ms=excluded.bucket_start_ms
    returning count_key
  ) insert into private_hot_updater_insights_report_counts
    (job_id,count_key,identity,section,metric,label,bucket_start_ms,value)
    select ${jobId}::uuid,input.count_key,input.identity,'installationIds','',
      input.install_id,-1,1 from input join manifest using(count_key)
    on conflict (job_id,count_key) do nothing`.execute(db);
  const saved = await sql<{
    count_key: string;
    identity: unknown;
    section: string;
    metric: string;
    label: string;
    bucket_start_ms: string;
    value: string;
  }>`
    select count_key, identity, section, metric, label, bucket_start_ms::text, value::text
    from private_hot_updater_insights_report_counts
    where job_id = ${jobId}::uuid and count_key in (${sql.join([...expected.keys()])})
    limit ${expected.size}`.execute(db);
  if (saved.rows.length !== expected.size) invalid();
  for (const row of saved.rows) {
    const identity = expected.get(row.count_key);
    if (
      row.value !== "1" ||
      row.section !== "installationIds" ||
      row.metric !== "" ||
      row.bucket_start_ms !== "-1" ||
      identity?.installId !== row.label ||
      identity.identity !== JSON.stringify(row.identity)
    )
      invalid();
    expected.delete(row.count_key);
  }
  if (expected.size !== 0) invalid();
};

/** Uses the parent worker's lease/error handling and its reserved control budget. */
export const stepPostgresInsightsSearch = async <TDatabase extends object>(
  jobs: ReturnType<typeof createPostgresInsightsJobs<TDatabase>>,
  token: PostgresInsightsReportLeaseToken,
  job: PostgresInsightsContainsJob,
  maxItems: number,
): Promise<{
  state: "progress" | "published";
  processed: number;
  jobId: string;
}> => {
  if (job.checkpoint.phase === "awaitIdentity") {
    await jobs.withLease(token, async () => ({ kind: "bindIdentity" }));
    return { state: "progress", processed: 0, jobId: job.id };
  }
  let processed = 0;
  await jobs.withLease(token, async (transaction, current) => {
    if (
      !isPostgresInsightsContainsJob(current) ||
      current.asOfMs === null ||
      current.sourceGeneration === null
    )
      return invalid();
    if (current.checkpoint.phase === "aliases") {
      // Alias page N, deduplicated latest M and set validation M, plus two
      // readiness rows. All six data SQL requests fit the parent's minimum128.
      const limit = Math.min(200, Math.floor((maxItems - 34) / 3));
      const aliases = await readPostgresInsightsAliasPage(
        transaction,
        current.baseJobId,
        current.checkpoint.afterAliasKey,
        limit,
      );
      const matches = new Map<string, string>();
      for (const alias of aliases) {
        const matchesQuery =
          current.query.kind === "installationContains"
            ? alias.normalizedAlias.includes(current.query.normalizedQuery)
            : alias.kind === "user" &&
              alias.originalAlias === current.query.userId;
        if (!matchesQuery) continue;
        const prior = matches.get(alias.installKey);
        if (prior !== undefined && prior !== alias.installId) return invalid();
        matches.set(alias.installKey, alias.installId);
      }
      const latest = await readPostgresInsightsLatestByKey(
        transaction,
        current.baseJobId,
        [...matches.keys()],
      );
      for (const row of latest)
        if (matches.get(row.installKey) !== row.event.install_id)
          return invalid();
      await savePostgresInsightsSearchMatches(transaction, current.id, latest);
      processed = aliases.length;
      return {
        kind: "progress",
        checkpoint:
          aliases.length < limit
            ? { phase: "ordering" }
            : { phase: "aliases", afterAliasKey: aliases.at(-1)!.aliasKey },
      };
    }
    if (current.checkpoint.phase === "ordering") {
      const ordered = await stepPostgresInsightsReportOrder(
        transaction,
        current.id,
        section,
      );
      processed = ordered.processed;
      return {
        kind: "progress",
        checkpoint: ordered.ready ? { phase: "complete" } : current.checkpoint,
      };
    }
    if (current.checkpoint.phase !== "complete") return invalid();
    const ready = await getPostgresInsightsReportOrderReady(
      transaction,
      current.id,
      section,
    );
    if (ready === null || !Number.isSafeInteger(Number(ready.totalRows)))
      return invalid();
    return { kind: "publishSearch", total: Number(ready.totalRows) };
  });
  return {
    state: job.checkpoint.phase === "complete" ? "published" : "progress",
    processed,
    jobId: job.id,
  };
};
