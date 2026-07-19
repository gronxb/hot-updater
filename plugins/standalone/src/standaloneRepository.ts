import {
  createDatabaseAdapter,
  databaseAnalyticsSupport,
  databaseBundleEventService,
} from "@hot-updater/plugin-core";

import { createBundleEventService } from "./standaloneBundleEventService";
import { createLegacyCompatibilityImplementation } from "./standaloneLegacyImplementation";
import type { StandaloneRepositoryConfig } from "./standaloneRoutes";

export { StandaloneDatabaseError } from "./standaloneHttp";
export type {
  RouteConfig,
  Routes,
  StandaloneRepositoryConfig,
} from "./standaloneRoutes";

/**
 * Compatibility bridge over the legacy aggregate `/api/bundles` HTTP API.
 *
 * Channel names are exposed through the adapter aggregate instead of a
 * synthetic fixed-model relation.
 */
export const standaloneRepository = <TContext = unknown>(
  config: StandaloneRepositoryConfig<TContext>,
) => {
  const recordRepository = createDatabaseAdapter<TContext>({
    name: "standalone-repository",
    adapter: () => createLegacyCompatibilityImplementation(config),
  });
  const { [databaseAnalyticsSupport]: analyticsSupport, ...repository } =
    recordRepository;
  void analyticsSupport;
  if (!config.supportsAnalytics) return repository;
  return Object.assign(repository, {
    [databaseBundleEventService]: createBundleEventService(config),
  });
};
