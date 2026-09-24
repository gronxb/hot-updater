import { PGlite } from "@electric-sql/pglite";
import type { InsightsModel } from "@hot-updater/plugin-core";
import {
  createMemoryAdapter,
  type DatabaseAdapter,
} from "@hot-updater/plugin-core/internal";
import {
  createPluginTestHarness,
  setupInsightsModelTestSuite,
} from "@hot-updater/test-utils";
import { afterAll } from "vitest";

import * as engine from "../../database";
import { createSqlAdapter } from "../../database/sql/sqlAdapter";
import { pgliteExecutor } from "../../database/sql/sqlTestExecutors";
import { createInsightsModel, insights } from "./index";

/** The plugin's model on a fresh adapter per test, behind one stable model. */
const onFreshAdapter = (adapter: () => DatabaseAdapter) => {
  let model: InsightsModel | undefined;
  const current = () => {
    if (model === undefined) throw new Error("Insights is reset per test.");
    return model;
  };
  const stable: InsightsModel = {
    recordEvent: (input) => current().recordEvent(input),
    listEvents: (input) => current().listEvents(input),
    findLatestEvents: (input) => current().findLatestEvents(input),
    countLatestEvents: (input) => current().countLatestEvents(input),
    countEvents: (input) => current().countEvents(input),
    getReleaseActivity: (input) => current().getReleaseActivity(input),
    getAppUsage: (input) => current().getAppUsage(input),
  };
  return {
    migrate: () => undefined,
    createDatabase: () => stable,
    reset: async () => {
      const harness = await createPluginTestHarness(insights(), {
        engine,
        adapter: adapter(),
      });
      model = createInsightsModel(harness.api);
    },
    dispose: () => undefined,
  };
};

setupInsightsModelTestSuite({
  name: "the Insights plugin's model on the memory adapter",
  ...onFreshAdapter(() => createMemoryAdapter()),
});

const pglite = new PGlite();
afterAll(() => pglite.close());
let resets = 0;

setupInsightsModelTestSuite({
  name: "the Insights plugin's model on PGlite",
  ...onFreshAdapter(() => {
    resets += 1;
    return createSqlAdapter({
      executor: pgliteExecutor(pglite),
      tablePrefix: `t${resets}_`,
    });
  }),
});
