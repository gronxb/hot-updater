import type { DatabaseAdapter } from "@hot-updater/plugin-core";

import { registerDatabaseAdapterBundleTests } from "./databaseAdapterBundleTests";
import { registerDatabaseAdapterCapabilityTests } from "./databaseAdapterCapabilityTests";
import { registerDatabaseAdapterQueryTests } from "./databaseAdapterQueryTests";
import { registerDatabaseAdapterRelationTests } from "./databaseAdapterRelationTests";
import type { DatabaseAdapterTestLifecycle } from "./databaseAdapterTestRunner";
import { setupDatabaseAdapterTestRunner } from "./databaseAdapterTestRunner";

export type DatabaseAdapterTestSuiteOptions =
  DatabaseAdapterTestLifecycle<DatabaseAdapter>;

export const setupDatabaseAdapterTestSuite = (
  options: DatabaseAdapterTestSuiteOptions,
): void => {
  setupDatabaseAdapterTestRunner(options, (state) => {
    registerDatabaseAdapterBundleTests(state);
    registerDatabaseAdapterRelationTests(state);
    registerDatabaseAdapterQueryTests(state);
    registerDatabaseAdapterCapabilityTests(state);
  });
};
