import type {
  BundleEventRow,
  InsightsInitialPublishedInstallationPage,
  InsightsInitialPublishedInstallationPageInput,
  InsightsInstallationPage,
  InsightsInstallationPageInput,
  InsightsLiveInstallationPage,
  InsightsLiveInstallationPageInput,
  InsightsPageEventsInput,
  InsightsPageEventsResult,
  InsightsPinnedInstallationPage,
  InsightsPinnedInstallationPageInput,
  InsightsPublishedInstallationPage,
  InsightsPublishedInstallationContinuation,
  InsightsPublishedInstallationContinuationInput,
  InsightsPublishedInstallationPageInput,
  InsightsReportInput,
  InsightsReportPage,
  InsightsReportPageInput,
  InsightsReportResult,
  InsightsModel,
} from "@hot-updater/plugin-core";

import type { ORMSQLProvider } from "../../../db/types";
import { appendPrismaInsightsEvent } from "./append";
import {
  assertPrismaInsightsClient,
  runPrismaInsightsTransaction,
  type PrismaInsightsClient,
} from "./client";
import { createPrismaInsightsInstallationPages } from "./installations";
import { createPrismaInsightsMaintenance } from "./maintenance";
import {
  createPrismaInsightsReports,
  runPrismaInsightsReportStep,
} from "./reports";
import {
  createPrismaInsightsSearchPages,
  runPrismaInsightsSearchStep,
} from "./search";
import { createPrismaInsightsEventPages } from "./source";
import { assertPrismaInsightsDatabaseNamespace } from "./utils";

export class PrismaInsightsModel implements InsightsModel {
  private sqliteOperationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: PrismaInsightsClient,
    private readonly provider: ORMSQLProvider,
    private readonly databaseNamespace: string,
  ) {
    assertPrismaInsightsDatabaseNamespace(databaseNamespace);
  }

  private run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    if (this.provider !== "sqlite") return operation();
    const pending = this.sqliteOperationTail.then(operation, operation);
    this.sqliteOperationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  append(row: BundleEventRow): Promise<void> {
    return this.run(() =>
      runPrismaInsightsTransaction(this.client, this.provider, (transaction) =>
        appendPrismaInsightsEvent(
          transaction,
          this.provider,
          this.databaseNamespace,
          row,
        ),
      ),
    );
  }

  runMaintenanceStep(
    input: Parameters<InsightsModel["runMaintenanceStep"]>[0],
  ): Promise<void> {
    return this.run(async () => {
      const { jobId, maxItems, maxRequests } = input;
      const canSplit = maxItems >= 3 && maxRequests >= 3;
      const stepItems = canSplit ? Math.floor(maxItems / 3) : maxItems;
      const stepRequests = canSplit ? Math.floor(maxRequests / 3) : maxRequests;
      const source = await createPrismaInsightsMaintenance(
        this.client,
        this.provider,
        this.databaseNamespace,
      ).runStep({ maxItems: stepItems, maxRequests: stepRequests });
      if (!source.ready || !canSplit) return;
      const search = await runPrismaInsightsSearchStep(
        this.client,
        this.provider,
        { jobId, maxItems: stepItems, maxRequests: stepRequests },
      );
      if (search.jobId !== null) return;
      await runPrismaInsightsReportStep(this.client, this.provider, {
        jobId,
        maxItems: stepItems,
        maxRequests: stepRequests,
      });
    });
  }

  pageEvents(
    input: InsightsPageEventsInput,
  ): Promise<InsightsPageEventsResult> {
    return this.run(() =>
      runPrismaInsightsTransaction(this.client, this.provider, (transaction) =>
        createPrismaInsightsEventPages(
          transaction,
          this.provider,
          this.databaseNamespace,
        ).pageEvents(input),
      ),
    );
  }

  pageInstallations(
    input: InsightsLiveInstallationPageInput,
  ): Promise<InsightsLiveInstallationPage>;
  pageInstallations(
    input: InsightsInitialPublishedInstallationPageInput,
  ): Promise<InsightsInitialPublishedInstallationPage>;
  pageInstallations(
    input: InsightsPinnedInstallationPageInput,
  ): Promise<InsightsPinnedInstallationPage>;
  pageInstallations(
    input: InsightsPublishedInstallationContinuationInput,
  ): Promise<InsightsPublishedInstallationContinuation>;
  pageInstallations(
    input: InsightsPublishedInstallationPageInput,
  ): Promise<InsightsPublishedInstallationPage>;
  pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage>;
  pageInstallations(
    input: InsightsInstallationPageInput,
  ): Promise<InsightsInstallationPage> {
    return this.run<InsightsInstallationPage>(() => {
      if (input.kind === "userId" || input.kind === "contains") {
        return createPrismaInsightsSearchPages(
          this.client,
          this.provider,
          this.databaseNamespace,
        ).pageInstallations(input);
      }
      return runPrismaInsightsTransaction(
        this.client,
        this.provider,
        (transaction) =>
          createPrismaInsightsInstallationPages(
            transaction,
            this.provider,
            this.databaseNamespace,
          ).pageInstallations(input),
      );
    });
  }

  getReport(input: InsightsReportInput): Promise<InsightsReportResult> {
    return this.run(() =>
      createPrismaInsightsReports(
        this.client,
        this.provider,
        this.databaseNamespace,
      ).getReport(input),
    );
  }

  pageReport(input: InsightsReportPageInput): Promise<InsightsReportPage> {
    return this.run(() =>
      createPrismaInsightsReports(
        this.client,
        this.provider,
        this.databaseNamespace,
      ).pageReport(input),
    );
  }
}

export const createPrismaInsightsModel = (
  client: object,
  provider: ORMSQLProvider,
  databaseNamespace: string,
): InsightsModel => {
  assertPrismaInsightsClient(client);
  return new PrismaInsightsModel(client, provider, databaseNamespace);
};
