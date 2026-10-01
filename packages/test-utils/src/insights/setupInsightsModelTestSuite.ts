import type { InsightsModel } from "@hot-updater/plugin-insights/server";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";

import type { DatabaseTestLifecycle } from "../databaseTestRunner";
import { registerInsightsModelTests } from "./insightsModelTests";

/**
 * The Insights report contract on one database: pass the Insights plugin's
 * model over it, `createInsightsModel(createDatabasePluginApis(database,
 * [insights()]).insights)`, as `createDatabase`.
 */
export const setupInsightsModelTestSuite = (
  lifecycle: DatabaseTestLifecycle<InsightsModel>,
): void => {
  describe(lifecycle.name, () => {
    let model: InsightsModel | undefined;
    const getDatabase = (): InsightsModel => {
      if (model === undefined) {
        throw new Error("The model is unavailable outside the test lifecycle");
      }
      return model;
    };
    beforeAll(async () => {
      await lifecycle.migrate();
      model = await lifecycle.createDatabase();
    });
    beforeEach(async () => {
      await lifecycle.reset(getDatabase());
    });
    afterAll(async () => {
      await lifecycle.dispose(getDatabase());
      model = undefined;
    });
    registerInsightsModelTests({ getDatabase });
  });
};
