import type {
  InsightsInitialPublishedInstallationPage,
  InsightsInitialPublishedInstallationPageInput,
  InsightsInstallationPage,
  InsightsInstallationPageInput,
  InsightsLiveInstallationPage,
  InsightsLiveInstallationPageInput,
  InsightsPinnedInstallationPage,
  InsightsPinnedInstallationPageInput,
  InsightsPublishedInstallationContinuation,
  InsightsPublishedInstallationContinuationInput,
  InsightsPublishedInstallationPage,
  InsightsPublishedInstallationPageInput,
  RequiredInsightsModel,
} from "@hot-updater/plugin-core/internal";
import { assertInsightsMaintenanceInputContract } from "@hot-updater/plugin-core/internal";
import { sql } from "drizzle-orm";

import type { DrizzleProvider } from "../../drizzle";
import {
  mutateDrizzleInsights,
  queryDrizzleInsights,
  transactDrizzleInsights,
  type DrizzleDB,
} from "../../drizzleLazyDB";
import { createDrizzleInsightsPages } from "./pages";
import { createDrizzleInsightsReports } from "./report";
import { DRIZZLE_INSIGHTS_STATE } from "./schema";
import { createDrizzleInsightsSearch } from "./search";
import { createDrizzleInsightsSource } from "./source";

export type DrizzleInsightsMaintenanceResult =
  | {
      readonly state: "complete";
      readonly publicationId: string;
      readonly usage: DrizzleInsightsMaintenanceUsage;
    }
  | {
      readonly state: "running" | "idle" | "failed";
      readonly jobId: string;
      readonly usage: DrizzleInsightsMaintenanceUsage;
    };

export type DrizzleInsightsMaintenanceUsage = {
  readonly items: number;
  readonly requests: number;
  readonly bytes: number;
};

const meteredDrizzleInsightsDB = (
  db: DrizzleDB,
  usage: { requests: number },
): DrizzleDB => ({
  ...db,
  insightsQuery: async (statement) => {
    usage.requests += 1;
    return queryDrizzleInsights(db, statement);
  },
  insightsMutation: async (statement) => {
    usage.requests += 1;
    await mutateDrizzleInsights(db, statement);
  },
  insightsTransaction: <TResult>(
    operation: (transaction: DrizzleDB) => Promise<TResult>,
  ) =>
    transactDrizzleInsights(db, (transaction) =>
      operation(meteredDrizzleInsightsDB(transaction, usage)),
    ),
});

export const runDrizzleInsightsMaintenanceStep = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
  jobId: string,
  input: { readonly maxItems: number; readonly maxRequests: number },
): Promise<DrizzleInsightsMaintenanceResult> => {
  assertInsightsMaintenanceInputContract(input);
  if (input.maxRequests < 4) {
    return {
      state: "idle",
      jobId,
      usage: { items: 0, requests: 0, bytes: 0 },
    };
  }
  const measured = { requests: 0 };
  const metered = meteredDrizzleInsightsDB(db, measured);
  const sourceState = await queryDrizzleInsights(
    metered,
    sql`select source_id,status from ${sql.identifier(DRIZZLE_INSIGHTS_STATE)}
      where id=1`,
  );
  if (sourceState[0]?.["source_id"] === jobId) {
    if (input.maxRequests < 24) {
      return {
        state: sourceState[0]?.["status"] === "failed" ? "failed" : "running",
        jobId,
        usage: { items: 0, requests: measured.requests, bytes: 0 },
      };
    }
    const sourceRows = Math.min(
      input.maxItems,
      200,
      Math.max(1, Math.floor((input.maxRequests - 17) / 3)),
    );
    const source = createDrizzleInsightsSource(metered, provider);
    const advanced = await source.advanceStep(sourceRows, true, true);
    const usage = {
      items: advanced.items,
      requests: measured.requests,
      bytes: advanced.bytes,
    };
    if (usage.requests > input.maxRequests) {
      throw new Error("Drizzle Insights source maintenance exceeded budget");
    }
    if (advanced.state.status === "ready") {
      return { state: "complete", publicationId: jobId, usage };
    }
    return {
      state: advanced.state.status === "failed" ? "failed" : "running",
      jobId,
      usage,
    };
  }
  const search = createDrizzleInsightsSearch(metered, provider);
  const reports = createDrizzleInsightsReports(metered, provider);
  const reportRows = Math.min(
    input.maxItems,
    200,
    Math.max(1, Math.floor((input.maxRequests - 4) / 20)),
  );
  const searchRows = Math.min(input.maxItems, 200);
  const preflightRows = Math.min(input.maxItems, 200);
  const searchProcess = input.maxRequests >= 10;
  const searchStatus = await search.advanceJob(
    jobId,
    searchRows,
    preflightRows,
    searchProcess,
  );
  const result =
    searchStatus.status === "missing"
      ? await reports.advanceJob(
          jobId,
          reportRows,
          preflightRows,
          input.maxRequests >= 24,
        )
      : searchStatus;
  const usage = {
    items: result.items,
    requests: measured.requests,
    bytes: result.bytes,
  };
  if (usage.requests > input.maxRequests) {
    throw new Error("Drizzle Insights job maintenance exceeded budget");
  }
  switch (result.status) {
    case "ready":
      return { state: "complete", publicationId: jobId, usage };
    case "queued":
    case "preparing":
      return { state: "running", jobId, usage };
    case "failed":
      return { state: "failed", jobId, usage };
    case "missing":
      return { state: "idle", jobId, usage };
  }
};

export const createDrizzleInsightsQueries = (
  db: DrizzleDB,
  provider: DrizzleProvider,
): RequiredInsightsModel => {
  const pages = createDrizzleInsightsPages(db, provider);
  const search = createDrizzleInsightsSearch(db, provider);
  const reports = createDrizzleInsightsReports(db, provider);
  function pageInstallations(
    input: InsightsLiveInstallationPageInput,
  ): Promise<InsightsLiveInstallationPage>;
  function pageInstallations(
    input: InsightsInitialPublishedInstallationPageInput,
  ): Promise<InsightsInitialPublishedInstallationPage>;
  function pageInstallations(
    input: InsightsPinnedInstallationPageInput,
  ): Promise<InsightsPinnedInstallationPage>;
  function pageInstallations(
    input: InsightsPublishedInstallationContinuationInput,
  ): Promise<InsightsPublishedInstallationContinuation>;
  function pageInstallations(
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage>;
  function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage>;
  function pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage> {
    if (input.kind === "all" || input.kind === "installationId") {
      return pages.pageLiveInstallations(input);
    }
    return search.pageInstallations(input);
  }
  return {
    append: pages.append,
    pageEvents: pages.pageEvents,
    pageInstallations,
    getReport: reports.getReport,
    pageReport: reports.pageReport,
  };
};
