import type {
  InsightsInstallationPage,
  InsightsReportPage,
} from "@hot-updater/plugin-core";
import {
  assertInsightsMaintenanceInputContract,
  type InsightsModel,
} from "@hot-updater/plugin-core/internal";
import {
  registerInsightsModelTests,
  type InsightsModelConformanceHarness,
} from "@hot-updater/test-utils";
import { env } from "cloudflare:test";
import { beforeAll, inject } from "vitest";

import type { D1Executor, D1Statement } from "../../src/d1Implementation";
import { createD1InsightsMaintenance } from "../../src/d1InsightsJobs";
import { createD1InsightsModel } from "../../src/d1InsightsModel";

const PRIMARY_DATABASE_NAMESPACE = "00000000-0000-4000-8000-000000000201";
const OTHER_DATABASE_NAMESPACE = "00000000-0000-4000-8000-000000000202";

declare module "vitest" {
  export interface ProvidedContext {
    prepareSql: string;
  }
}

type MeasuredExecutor = D1Executor & {
  readonly getLastReadCount: () => number;
};

const measuredExecutor = (
  database: D1Database,
  clock: { nowMs: number },
): MeasuredExecutor => {
  let lastReadCount = 0;
  return {
    getLastReadCount: () => lastReadCount,
    async query(sql, params) {
      if (/SELECT CAST\(strftime\('%s', 'now'\)/i.test(sql)) {
        lastReadCount = 1;
        return [{ now_ms: clock.nowMs }];
      }
      const result = await database
        .prepare(sql)
        .bind(...params)
        .all();
      if (
        sql.includes("WITH source_state AS (") &&
        sql.includes("), page AS (")
      ) {
        lastReadCount = result.results.filter(
          (row) => typeof row.event_id === "string",
        ).length;
      } else if (
        sql.includes(
          "FROM private_hot_updater_insights_job_memberships AS membership",
        ) ||
        sql.includes(
          "SELECT ordinal, filter_ordinal, row_bytes, row_json FROM private_hot_updater_insights_job_page_rows",
        )
      ) {
        lastReadCount = result.results.length;
      }
      return result.results;
    },
    async batch(statements: readonly D1Statement[]) {
      const results = await database.batch(
        statements.map(({ sql, params }) =>
          database.prepare(sql).bind(...params),
        ),
      );
      const saved = results.map(({ results: rows }) => rows ?? []);
      const rowCount = saved.reduce((total, rows) => total + rows.length, 0);
      if (rowCount > 0) lastReadCount = rowCount;
      return saved;
    },
  };
};

const reset = async (database: D1Database): Promise<void> => {
  await database.batch(
    [
      "private_hot_updater_insights_job_page_rows",
      "private_hot_updater_insights_job_sections",
      "private_hot_updater_insights_job_order",
      "private_hot_updater_insights_job_memberships",
      "private_hot_updater_insights_job_counts",
      "private_hot_updater_insights_job_latest",
      "private_hot_updater_insights_jobs",
      "private_hot_updater_insights_job_heads",
      "private_hot_updater_insights_installation_versions",
      "private_hot_updater_insights_installation_aliases",
      "private_hot_updater_insights_live_installations",
      "private_hot_updater_insights_installation_events",
      "private_hot_updater_insights_bundle_events",
      "private_hot_updater_insights_source_events",
      "private_hot_updater_insights_pending_events",
      "bundle_events",
    ].map((table) => database.prepare(`DELETE FROM ${table}`)),
  );
  await database
    .prepare(
      `UPDATE private_hot_updater_insights_source_state
      SET database_namespace = NULL, generation = 0, status = 'ready',
        backfill_upper_received_at_ms = NULL, backfill_upper_id = NULL,
        backfill_after_received_at_ms = NULL, backfill_after_id = NULL
      WHERE id = 1`,
    )
    .run();
};

const expiredModel = (
  base: InsightsModel,
  expired: ReadonlySet<string>,
): InsightsModel =>
  new Proxy(base, {
    get(target, property, receiver) {
      if (property === "pageInstallations") {
        return async (input: {
          readonly cursor?: string;
          readonly publicationId?: string;
        }) => {
          let publicationId = input.publicationId;
          if (publicationId === undefined && input.cursor !== undefined) {
            try {
              const parsed: unknown = JSON.parse(input.cursor);
              if (Array.isArray(parsed) && typeof parsed[2] === "string") {
                publicationId = parsed[2];
              }
            } catch {
              // The provider validates malformed cursors.
            }
          }
          return publicationId !== undefined && expired.has(publicationId)
            ? ({
                state: "expired",
                publicationId,
              } satisfies InsightsInstallationPage)
            : Reflect.apply(target.pageInstallations, target, [input]);
        };
      }
      if (property === "pageReport") {
        return async (input: { readonly publicationId: string }) =>
          expired.has(input.publicationId)
            ? ({
                state: "expired",
                publicationId: input.publicationId,
              } satisfies InsightsReportPage)
            : target.pageReport(
                input as Parameters<typeof target.pageReport>[0],
              );
      }
      return Reflect.get(target, property, receiver);
    },
  });

beforeAll(async () => {
  const sql = inject("prepareSql");
  await env.DB.prepare(sql).run();
  await env.OTHER_DB.prepare(sql).run();
});

registerInsightsModelTests(
  async (): Promise<InsightsModelConformanceHarness> => {
    await reset(env.DB);
    await reset(env.OTHER_DB);
    const primaryClock = { nowMs: 1_000 };
    const otherClock = { nowMs: 1_000 };
    const primaryExecutor = measuredExecutor(env.DB, primaryClock);
    const otherExecutor = measuredExecutor(env.OTHER_DB, otherClock);
    const expired = new Set<string>();
    const completed = new Set<string>();
    const runTargetedStep = async (
      database: D1Database,
      executor: MeasuredExecutor,
      databaseNamespace: string,
      jobId: string,
      input: { readonly maxItems: number; readonly maxRequests: number },
    ) => {
      assertInsightsMaintenanceInputContract(input);
      if (input.maxRequests < 3) {
        return createD1InsightsMaintenance(executor, databaseNamespace).runStep(
          input,
        );
      }
      await database
        .prepare(
          `UPDATE private_hot_updater_insights_jobs
          SET claimable_at_ms = CASE WHEN id = ? THEN 0 ELSE 9007199254740991 END
          WHERE status = 'queued'`,
        )
        .bind(jobId)
        .run();
      const result = await createD1InsightsMaintenance(
        executor,
        databaseNamespace,
      ).runStep({
        ...input,
        maxRequests: input.maxRequests - 1,
      });
      return { ...result, requests: result.requests + 1 };
    };
    const createHarness = (): InsightsModelConformanceHarness => ({
      model: expiredModel(
        createD1InsightsModel(primaryExecutor, PRIMARY_DATABASE_NAMESPACE),
        expired,
      ),
      otherNamespaceModel: createD1InsightsModel(
        otherExecutor,
        OTHER_DATABASE_NAMESPACE,
      ),
      async runJobStep(jobId, input) {
        const result = await runTargetedStep(
          env.DB,
          primaryExecutor,
          PRIMARY_DATABASE_NAMESPACE,
          jobId,
          input,
        );
        const usage = {
          items: result.processed,
          requests: result.requests,
        };
        if (result.state === "published") {
          completed.add(jobId);
          return {
            state: "complete",
            publicationId: result.jobId ?? jobId,
            usage,
          };
        }
        if (result.state === "failed") return { state: "failed", jobId, usage };
        if (result.state === "idle") return { state: "idle", jobId, usage };
        return { state: "running", jobId, usage };
      },
      async runOtherNamespaceJobStep(jobId, input) {
        const result = await runTargetedStep(
          env.OTHER_DB,
          otherExecutor,
          OTHER_DATABASE_NAMESPACE,
          jobId,
          input,
        );
        const usage = {
          items: result.processed,
          requests: result.requests,
        };
        if (result.state === "published") {
          return {
            state: "complete",
            publicationId: result.jobId ?? jobId,
            usage,
          };
        }
        if (result.state === "failed") {
          return { state: "failed", jobId, usage };
        }
        if (result.state === "idle") return { state: "idle", jobId, usage };
        return { state: "running", jobId, usage };
      },
      reopen: createHarness,
      async insertMigrationPoisonRow() {
        const row = {
          id: "00000000-0000-7000-8000-0000000000ff",
          type: "UNCHANGED" as const,
          install_id: "poison-install",
          user_id: "poison",
          username: "poison",
          from_bundle_id: null,
          from_release_id: null,
          to_bundle_id: "poison-bundle",
          to_release_id: null,
          platform: "ios" as const,
          app_version: "1.0.0",
          channel: "production",
          cohort: "0",
          update_strategy: null,
          fingerprint_hash: null,
          sdk_version: null,
          received_at_ms: 900,
        };
        await createD1InsightsModel(
          primaryExecutor,
          PRIMARY_DATABASE_NAMESPACE,
        ).append(row);
        await env.DB.prepare(
          `UPDATE private_hot_updater_insights_source_events
          SET event_json = '{"corrupt":true}' WHERE event_id = ?`,
        )
          .bind(row.id)
          .run();
      },
      setCurrentTimeMs(nowMs) {
        primaryClock.nowMs = nowMs;
      },
      expirePublication(publicationId) {
        expired.add(publicationId);
      },
      publicationStateForJob(jobId) {
        return completed.has(jobId) ? "complete" : "absent";
      },
      getLastStorageReadCount(namespace = "primary") {
        return namespace === "primary"
          ? primaryExecutor.getLastReadCount()
          : otherExecutor.getLastReadCount();
      },
      getPageEventsCandidateReadBudget: () => 4_096,
      getPageInstallationsCandidateReadBudget: () => 4_096,
      getPageReportCandidateReadBudget: () => 4_096,
    });
    return createHarness();
  },
);
