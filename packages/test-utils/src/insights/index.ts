import type { InsightsModel } from "@hot-updater/plugin-insights/server";
import { describe } from "vitest";

import type { HttpTestClient } from "../httpTestClient";
import { registerInsightsModelTests } from "./insightsModelTests";
import { setupInsightsHttpTestSuite } from "./setupInsightsHttpTestSuite";

export { expectInsightsIndex } from "./expectInsightsIndex";
export { createBundleEventRowFixture } from "./fixtures";
export { setupInsightsHttpTestSuite } from "./setupInsightsHttpTestSuite";
export { setupInsightsModelTestSuite } from "./setupInsightsModelTestSuite";

/**
 * The Insights plugin's tests, for `setupDatabaseTestSuite`'s `plugins`: its
 * HTTP routes on the provider's server, which must run `insights()`, and
 * with `createModel` its report contract on the provider's database, such as
 * `(database) => createInsightsModel(createDatabasePluginApis(database,
 * [insights()]).insights)`.
 */
export const insightsTestSuite = <TDatabase = unknown>(
  options: {
    readonly createModel?: (database: TDatabase) => InsightsModel;
  } = {},
) => ({
  name: "Insights plugin",
  register: (context: {
    readonly getClient: () => HttpTestClient;
    readonly getDatabase: () => TDatabase;
  }): void => {
    setupInsightsHttpTestSuite({ getClient: context.getClient });
    const { createModel } = options;
    if (createModel !== undefined) {
      describe("Insights model", () => {
        registerInsightsModelTests({
          getDatabase: () => createModel(context.getDatabase()),
        });
      });
    }
  },
});
