import type { InsightsProvider } from "../../packages/server/src/insights/types.ts";
import type { ConsoleInsightsQaClient } from "./console-insights-qa.ts";

export const createConsoleInsightsProviderClient = (
  provider: InsightsProvider,
): ConsoleInsightsQaClient => ({
  getReportingOverview: (input) => provider.getReportingOverview(input),
  getInstallation: (input) => provider.getInstallation(input),
  listEvents: (input = {}) => provider.listEvents(input),
  listInstallationEvents: (input) => provider.listInstallationEvents(input),
  pageInstallationsByCurrentUserId: (input) =>
    provider.pageInstallationsByCurrentUserId(input),
});
