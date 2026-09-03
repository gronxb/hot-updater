export {
  createDatabasePluginAdapter,
  DatabaseRowReferencedError,
  type DatabasePluginAdapter,
} from "./createDatabasePlugin";
export { databaseFields } from "./types/databaseFields";
export { readInsightsReportQuery } from "./insightsReportQuery";
export {
  readInsightsInstallationPageInput,
  readInsightsPageEventsInput,
} from "./insightsPageQuery";
export {
  readInsightsReportPageInput,
  readInsightsReportPageQuery,
  createInsightsReportPageCursor,
  INSIGHTS_REPORT_PAGE_ORDERING_REVISION,
} from "./insightsReportPageQuery";
export {
  createInsightsReportProjection,
  type InsightsReportProjection,
} from "./insightsReportProjection";
export type * from "./types/internal";
export * from "./insightsContract";

/** Internal storage fence shared by the official database integrations. */
export const OFFICIAL_INSIGHTS_DATABASE_NAMESPACE =
  "00000000-0000-4000-8000-000000000001";
