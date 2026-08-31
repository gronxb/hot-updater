import { DatabasePluginInputError } from "@hot-updater/plugin-core";

import { readPostgresInsightsAliasPage } from "./postgresInsightsAliases";
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
import { savePostgresInsightsSearchMatches } from "./postgresInsightsSearchData";

const section = { section: "installationIds" } as const;
const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-result");
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
        if (!alias.normalizedAlias.includes(current.query.normalizedQuery))
          continue;
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
