import type { DatabaseAdapter } from "@hot-updater/plugin-core";

import { registerDatabaseAdapterBundleTests } from "./databaseAdapterBundleTests";
import { registerDatabaseAdapterCapabilityTests } from "./databaseAdapterCapabilityTests";
import { registerDatabaseAdapterQueryTests } from "./databaseAdapterQueryTests";
import { registerDatabaseAdapterRelationTests } from "./databaseAdapterRelationTests";
import type { DatabaseAdapterTestLifecycle } from "./databaseAdapterTestRunner";
import { setupDatabaseAdapterTestRunner } from "./databaseAdapterTestRunner";

export type DatabaseAdapterTestSuiteOptions<TContext = unknown> =
  DatabaseAdapterTestLifecycle<DatabaseAdapter<TContext>, TContext>;

export const setupDatabaseAdapterTestSuite = <TContext = unknown>(
  options: DatabaseAdapterTestSuiteOptions<TContext>,
): void => {
  setupDatabaseAdapterTestRunner(options, (state) => {
    registerDatabaseAdapterBundleTests(state);
    registerDatabaseAdapterRelationTests(state);
    registerDatabaseAdapterQueryTests(state);
    registerDatabaseAdapterCapabilityTests(state);
  });
};
