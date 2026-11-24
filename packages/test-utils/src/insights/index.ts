import type {
  AnyHotUpdaterPlugin,
  EngineDatabase,
} from "@hot-updater/plugin-core";
import type { InsightsModel } from "@hot-updater/plugin-insights/server";
import { describe } from "vitest";

import type { HttpTestClient } from "../httpTestClient";
import { registerInsightsBackfillTests } from "./insightsBackfillTests";
import { registerInsightsModelTests } from "./insightsModelTests";
import { setupInsightsHttpTestSuite } from "./setupInsightsHttpTestSuite";

export { expectInsightsIndex } from "./expectInsightsIndex";
export { createBundleEventRowFixture } from "./fixtures";
export { insights11TestPlugin, type Insights11TestApi } from "./insights11";
export { setupInsightsHttpTestSuite } from "./setupInsightsHttpTestSuite";
export { setupInsightsModelTestSuite } from "./setupInsightsModelTestSuite";

/**
 * The Insights plugin's tests, for `setupDatabaseTestSuite`'s `plugins`: its
 * HTTP routes on the provider's server, which must run `insights()`; with
 * `createModel` its report contract on the provider's database, such as
 * `(database) => createInsightsModel(createHotUpdater({ database, storage,
 * plugins: [insights()], clientAccess: "public" }).api.insights)`; and with
 * `createApi` the backfill of a 1.1 server's rows, such as `(database,
 * plugin = insights()) => createHotUpdater({ database, storage, plugins:
 * [plugin], clientAccess: "public" }).api.insights`.
 */
export const insightsTestSuite = <TDatabase = EngineDatabase>(
  options: {
    readonly createModel?: (database: TDatabase) => InsightsModel;
    readonly createApi?: (
      database: TDatabase,
      plugin?: AnyHotUpdaterPlugin,
    ) => unknown;
  } = {},
) => ({
  name: "Insights plugin",
  register: (context: {
    readonly getClient: () => HttpTestClient;
    readonly getDatabase: () => TDatabase;
  }): void => {
    setupInsightsHttpTestSuite({ getClient: context.getClient });
    const { createModel, createApi } = options;
    if (createModel !== undefined) {
      describe("Insights model", () => {
        registerInsightsModelTests({
          getDatabase: () => createModel(context.getDatabase()),
        });
      });
    }
    if (createApi !== undefined) {
      registerInsightsBackfillTests({
        getDatabase: context.getDatabase,
        createApi: (database, plugin) =>
          createApi(database as TDatabase, plugin),
      });
    }
  },
});
