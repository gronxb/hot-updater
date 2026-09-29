import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import {
  setupDatabaseTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";

import { createDatabasePluginApis } from "./assembly/databasePlugins";
import { createHotUpdater } from "./index";
import { createInsightsModel, insights } from "./plugins/insights";

let adapter = createMemoryAdapter();

setupDatabaseTestSuite({
  name: "in-memory engine database",
  migrate: () => undefined,
  createDatabase: () => ({
    name: "memory",
    // Each test's reset swaps in an empty adapter.
    adapter: new Proxy({} as typeof adapter, {
      get: (_target, key) => Reflect.get(adapter, key),
    }),
  }),
  reset: () => {
    adapter = createMemoryAdapter();
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
