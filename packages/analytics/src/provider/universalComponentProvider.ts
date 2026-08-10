import type { UniversalComponentDataSource } from "@hot-updater/plugin-core";

import { createBoundedAnalyticsProvider } from "./bounded/provider.js";
import type { AnalyticsProvider } from "./types.js";
import { createUniversalComponentAnalyticsPersistence } from "./universalComponentPersistence.js";

export const createUniversalComponentAnalyticsProvider = (
  source: UniversalComponentDataSource,
): Extract<AnalyticsProvider, { readonly mode: "bounded" }> =>
  createBoundedAnalyticsProvider(
    createUniversalComponentAnalyticsPersistence(source),
  );
