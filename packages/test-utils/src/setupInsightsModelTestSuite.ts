import type { InsightsModel } from "@hot-updater/plugin-core";

import {
  setupDatabaseTestRunner,
  type DatabaseTestLifecycle,
} from "./databaseTestRunner";
import { registerInsightsModelTests } from "./insightsModelTests";

/**
 * The Insights report contract on one database: pass the Insights plugin's
 * model over it, `createInsightsModel(createDatabasePluginApis(database,
 * [insights()]).insights)`, as `createDatabase`.
 */
export const setupInsightsModelTestSuite = (
  lifecycle: DatabaseTestLifecycle<InsightsModel>,
): void => setupDatabaseTestRunner(lifecycle, registerInsightsModelTests);
