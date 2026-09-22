import {
  setupDatabasePluginTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";

import { createInMemoryDatabaseHarness } from "../../test-utils/test/inMemoryDatabasePlugin";
import { createHotUpdater } from "./index";

const harness = createInMemoryDatabaseHarness();

setupDatabasePluginTestSuite({
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({ ...options, clientAccess: { type: "public" } })
        .handlers,
    ),
  name: "in-memory database plugin",
  createPlugin: () => harness.plugin,
  migrate: () => undefined,
  reset: () => harness.reset(),
  dispose: () => undefined,
});
