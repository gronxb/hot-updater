import type { InsightsProvider } from "../../packages/server/src/insights/types.ts";
import type { ConsoleInsightsQaClient } from "./console-insights-qa.ts";

export const createConsoleInsightsProviderClient = (
  provider: InsightsProvider,
): ConsoleInsightsQaClient => ({
  getActiveOverview: () =>
    provider.getActiveInstallationOverview({ window: "24h" }),
  getInstallation: (installId) => provider.getInstallation(installId),
  pageEvents: (input = {}) => provider.pageEvents(input),
  pageInstallationEvents: (installId, input = {}) =>
    provider.pageInstallationEvents({ ...input, installId }),
  pageInstallationsByCurrentUserId: (userId, input = {}) =>
    provider.pageInstallationsByCurrentUserId({ ...input, userId }),
});
