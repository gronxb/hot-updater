import { createMemoryAdapter } from "@hot-updater/plugin-core";
import {
  setupDatabaseTestSuite,
  startHttpTestServer,
  insightsTestSuite,
} from "@hot-updater/test-utils";

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
  plugins: [
    insightsTestSuite({
      createModel: (database) =>
        createInsightsModel(
          createHotUpdater({
            database,
            plugins: [insights()],
            clientAccess: "public",
          }).api.insights,
        ),
    }),
  ],
});
