import {
  attachCapabilityContribution,
  type DatabasePlugin,
  type HotUpdaterInfrastructureRuntime,
} from "@hot-updater/plugin-core";

import { createBoundedAnalyticsProvider } from "./bounded/provider";
import { analyticsProviderToken } from "./token";
import type { AnalyticsProvider } from "./types";

const analyticsProviderCarriers = new WeakSet<object>();

export type AnalyticsProviderFactory = (
  runtime: HotUpdaterInfrastructureRuntime,
) => AnalyticsProvider;

const createDefaultProvider: AnalyticsProviderFactory = (runtime) =>
  createBoundedAnalyticsProvider(runtime.database);

export const withAnalyticsProvider = <TDatabase extends DatabasePlugin>(
  database: TDatabase,
  factory: AnalyticsProviderFactory = createDefaultProvider,
): TDatabase => {
  if (analyticsProviderCarriers.has(database)) {
    return database;
  }
  const wrapped = attachCapabilityContribution(database, {
    token: analyticsProviderToken,
    create: factory,
  });
  analyticsProviderCarriers.add(wrapped);
  return wrapped;
};
