import type { DatabasePlugin } from "@hot-updater/plugin-core";

import { registerDatabasePluginInsightsTests } from "./databasePluginInsightsTests";
import { registerDatabasePluginOfficialDomainTests } from "./databasePluginOfficialDomainTests";
import {
  type DatabasePluginTestLifecycle,
  setupDatabasePluginTestRunner,
} from "./databasePluginTestRunner";

export type { DatabasePluginTestLifecycle } from "./databasePluginTestRunner";

/** The Insights report contract and the official domain suite, without the HTTP suite. */
export const setupInsightsModelTestSuite = (
  lifecycle: DatabasePluginTestLifecycle<DatabasePlugin>,
): void =>
  setupDatabasePluginTestRunner(lifecycle, (state) => {
    registerDatabasePluginOfficialDomainTests(state);
    registerDatabasePluginInsightsTests(state);
  });
