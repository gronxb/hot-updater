import type { AnalyticsProvider } from "../../packages/server/src/analytics/types.ts";
import type { ConsoleAnalyticsQaClient } from "./console-analytics-qa.ts";

export const createConsoleAnalyticsProviderClient = (
  provider: AnalyticsProvider,
): ConsoleAnalyticsQaClient => ({
  getActiveOverview: () =>
    provider.getActiveInstallationOverview({ window: "24h" }),
  getBundleAnalytics: (bundleId) =>
    provider.getBundleEventAnalytics(bundleId, "30d", 50, 0),
  getCapabilities: async () => ({ analytics: true }),
  getHistory: (installId) => provider.getInstallationHistory(installId, 50, 0),
  getOverview: () => provider.getBundleEventOverview(),
  getSummary: (bundleId) => provider.getBundleEventSummary(bundleId),
  searchInstallations: (query) => provider.searchInstallations(query, 50, 0),
});
