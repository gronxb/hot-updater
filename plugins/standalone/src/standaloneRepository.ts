import { withAnalyticsProvider } from "@hot-updater/analytics/provider";
import { createDatabasePlugin } from "@hot-updater/plugin-core";

import { createStandaloneAnalyticsProvider } from "./standaloneAnalyticsProvider";
import { createStandaloneBundleRemote } from "./standaloneBundleRemote";
import { createLegacyCompatibilityImplementation } from "./standaloneLegacyImplementation";
import { runLegacyAggregateTransaction } from "./standaloneLegacyTransaction";
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
  const repository = createDatabasePlugin({
    name: "standalone-repository",
    plugin: () => {
      const remote = createStandaloneBundleRemote(config);
      const implementation = createLegacyCompatibilityImplementation(remote);
      return {
        ...implementation,
        transaction: (callback) =>
          runLegacyAggregateTransaction(remote, callback),
      };
    },
  });
  return withAnalyticsProvider(repository, () =>
    createStandaloneAnalyticsProvider(config),
  );
};
