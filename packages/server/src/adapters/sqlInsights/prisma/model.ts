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
import { createPrismaInsightsReports } from "./reports";
import { createPrismaInsightsSearchPages } from "./search";
import { createPrismaInsightsEventPages } from "./source";
import { assertPrismaInsightsDatabaseNamespace } from "./utils";

export class PrismaInsightsModel implements InsightsModel {
  constructor(
    private readonly client: PrismaInsightsClient,
    private readonly provider: ORMSQLProvider,
    private readonly databaseNamespace: string,
  ) {
    assertPrismaInsightsDatabaseNamespace(databaseNamespace);
  }

  append(row: BundleEventRow): Promise<void> {
    return runPrismaInsightsTransaction(
      this.client,
      this.provider,
      (transaction) =>
        appendPrismaInsightsEvent(
          transaction,
          this.provider,
          this.databaseNamespace,
          row,
        ),
    );
  }

  pageEvents(
    input: InsightsPageEventsInput,
  ): Promise<InsightsPageEventsResult> {
    return runPrismaInsightsTransaction(
      this.client,
      this.provider,
      (transaction) =>
        createPrismaInsightsEventPages(
          transaction,
          this.provider,
          this.databaseNamespace,
        ).pageEvents(input),
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
  }

  getReport(input: InsightsReportInput): Promise<InsightsReportResult> {
    return createPrismaInsightsReports(
      this.client,
      this.provider,
      this.databaseNamespace,
    ).getReport(input);
  }

  pageReport(input: InsightsReportPageInput): Promise<InsightsReportPage> {
    return createPrismaInsightsReports(
      this.client,
      this.provider,
      this.databaseNamespace,
    ).pageReport(input);
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
