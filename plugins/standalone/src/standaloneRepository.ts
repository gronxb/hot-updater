import {
  createDatabasePlugin,
  databaseAnalyticsSupport,
  databaseBundleEventService,
} from "@hot-updater/plugin-core";

import {
  createAnalyticsCapabilityProbe,
  internalAnalyticsCapabilityProbe,
} from "./standaloneAnalyticsCapability";
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
 * Channel names are exposed through the plugin aggregate instead of a
 * synthetic fixed-model relation.
 */
export const standaloneRepository = (config: StandaloneRepositoryConfig) => {
  const recordRepository = createDatabasePlugin({
    name: "standalone-repository",
    plugin: () => createLegacyCompatibilityImplementation(config),
  });
  const { [databaseAnalyticsSupport]: analyticsSupport, ...repository } =
    recordRepository;
  void analyticsSupport;
  return Object.assign(repository, {
    [databaseBundleEventService]: createBundleEventService(config),
    [internalAnalyticsCapabilityProbe]: createAnalyticsCapabilityProbe(config),
  });
};
