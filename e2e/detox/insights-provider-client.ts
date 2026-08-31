import type { InsightsProvider } from "../../packages/server/src/insights/types.ts";
import type { ConsoleInsightsQaClient } from "./console-insights-qa.ts";

export const createConsoleInsightsProviderClient = (
  provider: InsightsProvider,
): ConsoleInsightsQaClient => ({
  getActiveOverview: () =>
    provider.getActiveInstallationOverview({ window: "24h" }),
  getBundleInsights: (bundleId) =>
    provider.getBundleEventInsights(bundleId, "30d", 50, 0),
  getCapabilities: async () => ({ insights: true }),
  getHistory: (installId) => provider.getInstallationHistory(installId, 50, 0),
  getOverview: () => provider.getBundleEventOverview(),
  getSummary: (bundleId) => provider.getBundleEventSummary(bundleId),
  searchInstallations: (query) => provider.searchInstallations(query, 50, 0),
});
