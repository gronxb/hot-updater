import type { EngineDatabase } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { createDatabasePluginApis } from "@hot-updater/server/db";
import {
  createInsightsModel,
  insights,
} from "@hot-updater/server/plugins/insights";
import {
  setupDatabaseTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";

import { mockDatabase } from "../mockDatabase";

let current = mockDatabase({ latency: { min: 0, max: 0 } });

setupDatabaseTestSuite({
  name: "mockDatabase",
  migrate: () => undefined,
  // Each test's reset swaps in an empty mock behind one stable database.
  createDatabase: (): EngineDatabase => ({
    name: "mockDatabase",
    adapter: new Proxy({} as EngineDatabase["adapter"], {
      get: (_target, key) => Reflect.get(current.adapter, key),
    }),
  }),
  reset: () => {
    current = mockDatabase({ latency: { min: 0, max: 0 } });
  },
  dispose: () => undefined,
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({
        ...options,
        plugins: [insights()],
        clientAccess: "public",
      }).handlers,
    ),
  createInsightsModel: (database) =>
    createInsightsModel(
      createDatabasePluginApis(database, [insights()]).insights,
    ),
});
