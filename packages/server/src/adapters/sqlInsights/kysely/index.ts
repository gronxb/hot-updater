import type {
  BundleEventRow,
  InsightsInitialPublishedInstallationPage,
  InsightsInitialPublishedInstallationPageInput,
  InsightsInstallationPageInput,
  InsightsLiveInstallationPage,
  InsightsLiveInstallationPageInput,
  InsightsPageEventsInput,
  InsightsPinnedInstallationPage,
  InsightsPinnedInstallationPageInput,
  InsightsPublishedInstallationContinuation,
  InsightsPublishedInstallationContinuationInput,
  InsightsPublishedInstallationPage,
  InsightsPublishedInstallationPageInput,
  InsightsReportInput,
  InsightsReportPageInput,
} from "@hot-updater/plugin-core";
import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
} from "@hot-updater/plugin-core";
import type { RequiredInsightsModel } from "@hot-updater/plugin-core/internal";
import {
  assertInsightsMaintenanceInputContract,
  INSIGHTS_MAINTENANCE_MAX_ITEMS,
  INSIGHTS_MAINTENANCE_MAX_REQUESTS,
} from "@hot-updater/plugin-core/internal";
import { sql, type Kysely } from "kysely";

import type { SQLProvider as KyselySQLProvider } from "../../kysely";
import {
  KYSELY_INSIGHTS_ALIAS_WORK_ROWS,
  KYSELY_INSIGHTS_WORK_ROWS,
  tables,
} from "./constants";
import {
  failKyselyInsightsSearch,
  pageKyselyInsightsInstallations,
  stepKyselyInsightsSearch,
} from "./installations";
import {
  failKyselyInsightsReport,
  getKyselyInsightsReport,
  pageKyselyInsightsReport,
  stepKyselyInsightsReport,
} from "./reports";
import {
  appendKyselyInsightsEvent,
  pageKyselyInsightsEvents,
  prepareKyselyInsightsSource,
  readKyselyInsightsState,
} from "./source";

export { getKyselyInsightsDDL, migrateKyselyInsights } from "./schema";
export { prepareKyselyInsightsSource } from "./source";

function pageInstallations<TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  input: InsightsInitialPublishedInstallationPageInput,
): Promise<InsightsInitialPublishedInstallationPage>;
function pageInstallations<TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  input: InsightsPinnedInstallationPageInput,
): Promise<InsightsPinnedInstallationPage>;
function pageInstallations<TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  input: InsightsPublishedInstallationContinuationInput,
): Promise<InsightsPublishedInstallationContinuation>;
function pageInstallations<TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  input: InsightsLiveInstallationPageInput,
): Promise<InsightsLiveInstallationPage>;
function pageInstallations<TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  input: InsightsPublishedInstallationPageInput,
): Promise<InsightsPublishedInstallationPage>;
function pageInstallations<TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  input: InsightsInstallationPageInput,
): ReturnType<typeof pageKyselyInsightsInstallations>;
function pageInstallations<TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  input: InsightsInstallationPageInput,
) {
  return pageKyselyInsightsInstallations(db, provider, input);
}

export const createKyselyInsightsModel = <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
): RequiredInsightsModel => {
  function pageInstallationMethod(
    input: InsightsInitialPublishedInstallationPageInput,
  ): Promise<InsightsInitialPublishedInstallationPage>;
  function pageInstallationMethod(
    input: InsightsPinnedInstallationPageInput,
  ): Promise<InsightsPinnedInstallationPage>;
  function pageInstallationMethod(
    input: InsightsPublishedInstallationContinuationInput,
  ): Promise<InsightsPublishedInstallationContinuation>;
  function pageInstallationMethod(
    input: InsightsLiveInstallationPageInput,
  ): Promise<InsightsLiveInstallationPage>;
  function pageInstallationMethod(
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage>;
  function pageInstallationMethod(
    input: InsightsInstallationPageInput,
  ): ReturnType<typeof pageKyselyInsightsInstallations>;
  function pageInstallationMethod(input: InsightsInstallationPageInput) {
    return pageInstallations(db, provider, input);
  }
  return {
    append: (row: BundleEventRow) =>
      appendKyselyInsightsEvent(db, provider, row),
    pageEvents: (input: InsightsPageEventsInput) =>
      pageKyselyInsightsEvents(db, input),
    pageInstallations: pageInstallationMethod,
    getReport: (input: InsightsReportInput) =>
      getKyselyInsightsReport(db, provider, input),
    pageReport: (input: InsightsReportPageInput) =>
      pageKyselyInsightsReport(db, provider, input),
  };
};

export const runKyselyInsightsMaintenanceStep = <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  input: { readonly maxItems: number; readonly maxRequests: number },
): Promise<{
  readonly state: "idle" | "progress" | "published" | "failed";
  readonly processed: number;
  readonly jobId?: string;
}> => {
  assertInsightsMaintenanceInputContract(input);
  if (
    input.maxItems > INSIGHTS_MAINTENANCE_MAX_ITEMS ||
    input.maxRequests > INSIGHTS_MAINTENANCE_MAX_REQUESTS
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (input.maxRequests < 10) {
    return Promise.resolve({ state: "idle", processed: 0 });
  }
  return (async () => {
    if (input.maxRequests < 20) {
      try {
        await readKyselyInsightsState(db);
      } catch (error) {
        if (!(error instanceof InsightsQueryNotReadyError)) throw error;
        return { state: "idle" as const, processed: 0 };
      }
    } else {
      const sourceLimit = Math.min(
        KYSELY_INSIGHTS_WORK_ROWS,
        input.maxItems,
        Math.floor((input.maxRequests - 5) / 12),
      );
      const source = await prepareKyselyInsightsSource(
        db,
        provider,
        sourceLimit,
      );
      if (source.state !== "ready" || source.processed > 0) {
        return { state: "progress" as const, processed: source.processed };
      }
    }
    type Work = {
      kind: "report" | "search";
      id: string;
      as_of_ms: unknown;
    };
    const readWork = async (
      table: string,
      kind: Work["kind"],
      state: "queued" | "preparing",
    ): Promise<Work | undefined> => {
      const result = await sql<Omit<Work, "kind">>`select id, as_of_ms
        from ${sql.table(table)} where state = ${state}
        order by as_of_ms, id limit 1`.execute(db);
      const row = result.rows[0];
      return row === undefined ? undefined : { ...row, kind };
    };
    const work = (
      await Promise.all([
        readWork(tables.searchJobs, "search", "queued"),
        readWork(tables.searchJobs, "search", "preparing"),
        readWork(tables.reportJobs, "report", "queued"),
        readWork(tables.reportJobs, "report", "preparing"),
      ])
    )
      .filter((item): item is Work => item !== undefined)
      .sort(
        (left, right) =>
          Number(left.as_of_ms) - Number(right.as_of_ms) ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) ||
          (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0),
      )[0];
    if (!work) return { state: "idle", processed: 0 };
    if (input.maxRequests < 20) {
      return { state: "idle", processed: 0, jobId: work.id };
    }
    try {
      const update =
        work.kind === "search"
          ? await stepKyselyInsightsSearch(
              db,
              provider,
              work.id,
              Math.min(
                KYSELY_INSIGHTS_ALIAS_WORK_ROWS,
                input.maxItems,
                Math.floor((input.maxRequests - 6) / 5),
              ),
            )
          : await stepKyselyInsightsReport(db, provider, work.id, input);
      return {
        state:
          update.job.state === "ready"
            ? "published"
            : update.job.state === "failed"
              ? "failed"
              : "progress",
        processed: update.processed,
        jobId: work.id,
      };
    } catch (error) {
      if (!(error instanceof DatabasePluginInputError)) throw error;
      if (work.kind === "search") {
        const job = await sql<
          Parameters<typeof failKyselyInsightsSearch>[2]
        >`select *
          from ${sql.table(tables.searchJobs)} where id = ${work.id}`.execute(
          db,
        );
        if (job.rows[0]) {
          await failKyselyInsightsSearch(db, provider, job.rows[0]);
        }
      } else {
        const job = await sql<
          Parameters<typeof failKyselyInsightsReport>[2]
        >`select *
          from ${sql.table(tables.reportJobs)} where id = ${work.id}`.execute(
          db,
        );
        if (job.rows[0]) {
          await failKyselyInsightsReport(db, provider, job.rows[0]);
        }
      }
      return { state: "failed", processed: 0, jobId: work.id };
    }
  })();
};
