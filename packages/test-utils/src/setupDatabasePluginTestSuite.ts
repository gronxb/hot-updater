import type { DatabasePlugin } from "@hot-updater/plugin-core";

import { registerDatabasePluginBundleTests } from "./databasePluginBundleTests";
import { registerDatabasePluginCapabilityTests } from "./databasePluginCapabilityTests";
import { registerDatabasePluginQueryTests } from "./databasePluginQueryTests";
import { registerDatabasePluginRelationTests } from "./databasePluginRelationTests";
import type { DatabasePluginTestLifecycle } from "./databasePluginTestRunner";
import { setupDatabasePluginTestRunner } from "./databasePluginTestRunner";

export type DatabasePluginTestSuiteOptions =
  DatabasePluginTestLifecycle<DatabasePlugin>;

export const setupDatabasePluginTestSuite = (
  options: DatabasePluginTestSuiteOptions,
): void => {
  setupDatabasePluginTestRunner(options, (state) => {
    registerDatabasePluginBundleTests(state);
    registerDatabasePluginRelationTests(state);
    registerDatabasePluginQueryTests(state);
    registerDatabasePluginCapabilityTests(state);
  });
};
