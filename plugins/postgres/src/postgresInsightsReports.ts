import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
} from "@hot-updater/plugin-core";
import { createInsightsReportProjection } from "@hot-updater/plugin-core/internal";
import type { Kysely } from "kysely";

import {
  assertPostgresInsightsAliasIndex,
  savePostgresInsightsAliases,
} from "./postgresInsightsAliases";
import {
  createPostgresInsightsJobs,
  PostgresInsightsLeaseLostError,
} from "./postgresInsightsJobs";
import {
  assertPostgresInsightsReportDataIndexes,
  countPostgresInsightsInstallation,
  readPostgresInsightsInstallations,
  readPostgresInsightsSummary,
  savePostgresInsightsProjection,
} from "./postgresInsightsReportData";
import {
  assertPostgresInsightsReportOrderIndexes,
  getPostgresInsightsReportOrderReady,
  stepPostgresInsightsReportOrder,
} from "./postgresInsightsReportOrder";
import { getPostgresInsightsReportOrderSections } from "./postgresInsightsReportSections";
import {
  createPostgresInsightsSourceTools,
  POSTGRES_SOURCE_SHARDS,
} from "./postgresInsightsSource";

/**
 * Internal report worker. Budgets include control statements, transaction
 * boundaries and returned DB rows, not just raw events. Reserve 32 requests/rows
 * for job/source control; a final installation can return 30 bucket rows and
 * perform 92 counter upserts. No phase reads until its worst case fits.
 */
export const createPostgresInsightsReportWorker = <TDatabase extends object>(
  db: Kysely<TDatabase>,
) => {
  const jobs = createPostgresInsightsJobs(db);
  const source = createPostgresInsightsSourceTools(db);
  return {
    async runStep(input: { maxItems: number; maxRequests: number }): Promise<{
      state: "idle" | "progress" | "published" | "not-ready" | "lease-lost";
      processed: number;
      jobId?: string;
    }> {
      // This provider's largest indivisible unit is one installation's 30
      // rolling buckets. These minima also cover a 100-bundle publication.
      if (
        !Number.isSafeInteger(input.maxItems) ||
        input.maxItems < 256 ||
        !Number.isSafeInteger(input.maxRequests) ||
        input.maxRequests < 128
      )
        throw new DatabasePluginInputError("invalid-query");
      await assertPostgresInsightsReportDataIndexes(db);
      await assertPostgresInsightsReportOrderIndexes(db);
      await assertPostgresInsightsAliasIndex(db);
      const lease = await jobs.leaseNext();
      if (lease === null) return { state: "idle", processed: 0 };
      const { token, job } = lease;
      let processed = 0;
      try {
        if (job.sourceGeneration === null) {
          const sourceGeneration = await source.capture();
          await jobs.withLease(token, async (_transaction, current) => ({
            kind: "progress",
            sourceGeneration,
            checkpoint:
              current.query.kind === "bundleSummaries" &&
              current.query.bundleIds.length === 0
                ? { phase: "complete" }
                : current.checkpoint,
          }));
          return { state: "progress", processed, jobId: job.id };
        }
        if (job.checkpoint.phase === "source") {
          // One event: raw row plus at most six membership/count result rows.
          // The global overview instead returns one latest row and up to three
          // alias identities across three write/read statements.
          const limit = Math.min(
            200,
            Math.floor((input.maxItems - 32) / 7),
            Math.floor((input.maxRequests - 32) / 6),
          );
          const page = await source.readPage({
            sourceGeneration: job.sourceGeneration,
            shard: job.checkpoint.shard,
            afterSequence: job.checkpoint.afterSequence,
            limit,
          });
          const projection = createInsightsReportProjection(
            job.query,
            job.asOfMs,
          );
          await jobs.withLease(token, async (transaction, current) => {
            if (current.checkpoint.phase !== "source")
              throw new Error("Invalid report phase.");
            for (const row of page) {
              const projected = projection.project(row.event);
              if (projected !== null) {
                await savePostgresInsightsProjection(
                  transaction,
                  current,
                  projected,
                );
                if (current.query.kind === "installationOverview")
                  await savePostgresInsightsAliases(
                    transaction,
                    current.id,
                    row.event,
                  );
              }
            }
            const exhausted = page.length < limit;
            const lastShard =
              current.checkpoint.shard === POSTGRES_SOURCE_SHARDS - 1;
            return {
              kind: "progress",
              checkpoint:
                exhausted && lastShard
                  ? current.query.kind === "bundleSummaries"
                    ? { phase: "complete" }
                    : current.query.kind === "bundleDetail"
                      ? { phase: "ordering", section: 0 }
                      : { phase: "installations", afterInstallKey: null }
                  : {
                      phase: "source",
                      shard: current.checkpoint.shard + (exhausted ? 1 : 0),
                      afterSequence: exhausted ? "0" : page.at(-1)!.sequence,
                    },
            };
          });
          processed = page.length;
        } else if (job.checkpoint.phase === "installations") {
          // Each installation: one latest row, up to30 bucket rows, 92 counters.
          const limit = Math.min(
            200,
            Math.floor((input.maxItems - 32) / 123),
            Math.floor((input.maxRequests - 32) / 93),
          );
          await jobs.withLease(token, async (transaction, current) => {
            if (current.checkpoint.phase !== "installations")
              throw new Error("Invalid report phase.");
            const page = await readPostgresInsightsInstallations(
              transaction,
              current.id,
              current.checkpoint.afterInstallKey,
              limit,
            );
            for (const row of page)
              await countPostgresInsightsInstallation(
                transaction,
                current,
                row,
              );
            processed = page.length;
            return {
              kind: "progress",
              checkpoint:
                page.length < limit
                  ? { phase: "ordering", section: 0 }
                  : {
                      phase: "installations",
                      afterInstallKey: page.at(-1)!.installKey,
                    },
            };
          });
        } else if (job.checkpoint.phase === "ordering") {
          await jobs.withLease(token, async (transaction, current) => {
            if (current.checkpoint.phase !== "ordering")
              throw new Error("Invalid report phase.");
            const sections = getPostgresInsightsReportOrderSections(
              current.query,
            );
            // A merge reads at most two 32-row runs and emits at most32 rows.
            const result = await stepPostgresInsightsReportOrder(
              transaction,
              current.id,
              sections[current.checkpoint.section]!,
            );
            processed = result.processed;
            return {
              kind: "progress",
              checkpoint: !result.ready
                ? current.checkpoint
                : current.checkpoint.section + 1 === sections.length
                  ? { phase: "complete" }
                  : {
                      phase: "ordering",
                      section: current.checkpoint.section + 1,
                    },
            };
          });
        } else {
          await jobs.withLease(token, async (transaction, current) => {
            for (const section of getPostgresInsightsReportOrderSections(
              current.query,
            )) {
              if (
                (await getPostgresInsightsReportOrderReady(
                  transaction,
                  current.id,
                  section,
                )) === null
              )
                throw new DatabasePluginInputError("invalid-result");
            }
            return {
              kind: "publish",
              summary: await readPostgresInsightsSummary(transaction, current),
            };
          });
          return { state: "published", processed, jobId: job.id };
        }
        return { state: "progress", processed, jobId: job.id };
      } catch (error) {
        if (error instanceof PostgresInsightsLeaseLostError)
          return { state: "lease-lost", processed: 0, jobId: job.id };
        if (error instanceof InsightsQueryNotReadyError) {
          try {
            await jobs.withLease(token, async () => ({ kind: "defer" }));
          } catch (failure) {
            if (!(failure instanceof PostgresInsightsLeaseLostError))
              throw failure;
            return { state: "lease-lost", processed: 0, jobId: job.id };
          }
          return { state: "not-ready", processed: 0, jobId: job.id };
        }
        // Persist terminal failure only after a successful rollback. Never loop
        // silently on a poison row or turn a failed partial result into zeros.
        try {
          await jobs.withLease(token, async () => ({ kind: "fail" }));
        } catch (failure) {
          if (!(failure instanceof PostgresInsightsLeaseLostError))
            throw failure;
          return { state: "lease-lost", processed: 0, jobId: job.id };
        }
        throw error;
      }
    },
  };
};
