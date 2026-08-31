import {
  DatabasePluginInputError,
  type BundleEventRow,
  type InsightsInstallationPageInput,
  type InsightsReportInput,
  type InsightsReportPageInput,
} from "@hot-updater/plugin-core";
import type { DatabasePluginImplementation } from "@hot-updater/plugin-core/internal";
import type { Kysely } from "kysely";

import { createPostgresInsightsEventQueries } from "./postgresInsights";
import { createPostgresInsightsInstallationLookup } from "./postgresInsightsInstallation";
import { createPostgresInsightsJobs } from "./postgresInsightsJobs";
import { createPostgresInsightsLivePages } from "./postgresInsightsLive";
import { createPostgresInsightsReportPages } from "./postgresInsightsReportPages";
import { createPostgresInsightsSearchPages } from "./postgresInsightsSearchPages";
import { appendPostgresInsightsEvent } from "./postgresInsightsSource";
import type { Database } from "./types";

/** PostgreSQL-internal target contract. It is not wired to the public model yet. */
export const createPostgresInsightsQueries = (
  db: Kysely<Database>,
  implementation: DatabasePluginImplementation,
) => {
  const events = createPostgresInsightsEventQueries(db, implementation);
  const exact = createPostgresInsightsInstallationLookup(db);
  const live = createPostgresInsightsLivePages(db);
  const search = createPostgresInsightsSearchPages(db);
  const jobs = createPostgresInsightsJobs(db);
  const reports = createPostgresInsightsReportPages(db);
  return {
    append(row: BundleEventRow) {
      return appendPostgresInsightsEvent(db, row).then(() => undefined);
    },
    pageEvents: events.page,
    pageInstallations(input: InsightsInstallationPageInput) {
      switch (input.kind) {
        case "all":
          return live.pageAll(input);
        case "installation":
          return exact.pageInstallation(input);
        case "contains":
          return search.pageContains(input);
        default:
          throw new DatabasePluginInputError("invalid-query");
      }
    },
    getReport(input: InsightsReportInput) {
      return jobs.getReport(input);
    },
    pageReport(input: InsightsReportPageInput) {
      return reports.pageReport(input);
    },
  };
};
