import type { InsightsReportQuery } from "@hot-updater/plugin-core";

import type { PostgresInsightsReportOrderSection } from "./postgresInsightsReportOrder";

/** Every ordered section must be immutable before the publication is visible. */
export const getPostgresInsightsReportOrderSections = (
  query: InsightsReportQuery,
): readonly PostgresInsightsReportOrderSection[] => {
  switch (query.kind) {
    case "bundleSummaries":
      return [];
    case "bundleDetail":
      return [
        { section: "movementCohorts", metric: "installed" },
        { section: "movementCohorts", metric: "recovered" },
      ];
    case "installationOverview":
      return [{ section: "bundleDistribution" }];
    case "activeOverview":
      return [
        { section: "bundleDistribution" },
        { section: "activeBundleTotals" },
      ];
  }
};
