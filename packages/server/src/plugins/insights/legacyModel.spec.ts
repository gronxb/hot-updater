import { PGlite } from "@electric-sql/pglite";
import type { DatabasePlugin, InsightsModel } from "@hot-updater/plugin-core";
import {
  createMemoryAdapter,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core/internal";
import {
  createPluginTestHarness,
  setupDatabasePluginTestSuite,
  setupInsightsModelTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { afterAll } from "vitest";

import { createInMemoryDatabaseHarness } from "../../../../test-utils/test/inMemoryDatabasePlugin";
import { createHotUpdater } from "../../createHotUpdaterCore";
import * as engine from "../../database";
import { createSqlAdapter } from "../../database/sql/sqlAdapter";
import { pgliteExecutor } from "../../database/sql/sqlTestExecutors";
import { createInsightsModel, insights } from "./index";

/**
 * Today's in-memory database with its Insights model replaced by the plugin,
 * so the existing Insights suites run against the plugin through the shim.
 */
const withInsightsPlugin = (adapter: () => DatabaseAdapter) => {
  const legacy = createInMemoryDatabaseHarness();
  let model: InsightsModel | undefined;
  const current = () => {
    if (model === undefined) throw new Error("Insights is reset per test.");
    return model;
  };
  const plugin: DatabasePlugin = {
    ...legacy.plugin,
    models: {
      ...legacy.plugin.models,
      insights: {
        recordEvent: (input) => current().recordEvent(input),
        listEvents: (input) => current().listEvents(input),
        findLatestEvents: (input) => current().findLatestEvents(input),
        countLatestEvents: (input) => current().countLatestEvents(input),
        countEvents: (input) => current().countEvents(input),
        getReleaseActivity: (input) => current().getReleaseActivity(input),
        getAppUsage: (input) => current().getAppUsage(input),
      },
    },
  };
  return {
    createPlugin: () => plugin,
    migrate: () => undefined,
    reset: async () => {
      legacy.reset();
      const harness = await createPluginTestHarness(insights(), {
        engine,
        adapter: adapter(),
      });
      model = createInsightsModel(harness.api);
    },
    dispose: () => undefined,
  };
};

setupDatabasePluginTestSuite({
  name: "in-memory database with the Insights plugin on the memory adapter",
  ...withInsightsPlugin(() => createMemoryAdapter()),
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({ ...options, clientAccess: { type: "public" } })
        .handlers,
    ),
});

const pglite = new PGlite();
afterAll(() => pglite.close());
let resets = 0;

setupInsightsModelTestSuite({
  name: "in-memory database with the Insights plugin on PGlite",
  ...withInsightsPlugin(() => {
    resets += 1;
    return createSqlAdapter({
      executor: pgliteExecutor(pglite),
      tablePrefix: `t${resets}_`,
    });
  }),
});
