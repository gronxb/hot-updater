import type { InsightsProvider } from "@hot-updater/plugin-insights/server";

import type { ConsoleInsightsQaClient } from "./console-insights-qa.ts";

/**
 * The QA client speaks the HTTP API's names, where a release ID is
 * `bundleId`; the provider's are `releaseId`. This maps them as the routes do.
 */
export const createConsoleInsightsProviderClient = (
  provider: InsightsProvider,
): ConsoleInsightsQaClient => ({
  getReportingOverview: async ({ bundleId, ...input }) => {
    const { bundle, ...overview } = await provider.getReportingOverview({
      ...input,
      ...(bundleId === undefined ? {} : { releaseId: bundleId }),
    });
    if (bundle === undefined) return overview;
    const { releaseId, ...counts } = bundle;
    return { ...overview, bundle: { ...counts, bundleId: releaseId } };
  },
  getInstallation: (input) => provider.getInstallation(input),
  listEvents: ({ bundle, ...input } = {}) => {
    if (bundle === undefined) return provider.listEvents(input);
    const { bundleId, ...selection } = bundle;
    return provider.listEvents({
      ...input,
      bundle: { ...selection, releaseId: bundleId },
    });
  },
  listInstallationEvents: (input) => provider.listInstallationEvents(input),
  pageInstallationsByCurrentUserId: (input) =>
    provider.pageInstallationsByCurrentUserId(input),
});
