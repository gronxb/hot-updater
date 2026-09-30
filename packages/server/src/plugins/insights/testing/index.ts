import { describe } from "vitest";

import type { InsightsModel } from "../modelTypes";
import { registerInsightsModelTests } from "./insightsModelTests";
import { setupInsightsHttpTestSuite } from "./setupInsightsHttpTestSuite";
import type { HttpTestClient } from "./types";

export { createBundleEventRowFixture } from "./fixtures";
export { setupInsightsHttpTestSuite } from "./setupInsightsHttpTestSuite";
export { setupInsightsModelTestSuite } from "./setupInsightsModelTestSuite";
export type {
  DatabaseTestLifecycle,
  DatabaseTestState,
  HttpTestClient,
  HttpTestRequest,
} from "./types";

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
