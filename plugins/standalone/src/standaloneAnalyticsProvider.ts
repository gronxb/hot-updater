import type { AnalyticsProvider } from "@hot-updater/analytics/provider";

import { createAnalyticsCapabilityProbe } from "./standaloneAnalyticsCapability";
import { createStandaloneAnalyticsOperations } from "./standaloneAnalyticsOperations";
import type { StandaloneRepositoryConfig } from "./standaloneRoutes";

export const createStandaloneAnalyticsProvider = (
  config: StandaloneRepositoryConfig,
): AnalyticsProvider => {
  const operations = createStandaloneAnalyticsOperations(config);
  const resolveAvailability = createAnalyticsCapabilityProbe(config);
  return Object.freeze({
    ...operations,
    mode: "dedicated",
    resolveAvailability,
  });
};
