import { analytics, type AnalyticsOptions } from "@hot-updater/analytics";

import { createStandaloneAnalyticsProvider } from "./standaloneAnalyticsProvider";
import type { StandaloneRepositoryConfig } from "./standaloneRoutes";

export type StandaloneAnalyticsOptions = Pick<AnalyticsOptions, "queryAccess">;

export const standaloneAnalytics = (
  config: StandaloneRepositoryConfig,
  options: StandaloneAnalyticsOptions = {},
): ReturnType<typeof analytics> =>
  analytics({
    ...options,
    provider: () => createStandaloneAnalyticsProvider(config),
  });
