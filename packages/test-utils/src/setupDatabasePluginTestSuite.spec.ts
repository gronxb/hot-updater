import { createHotUpdater } from "../../server/src/index";
import { createInMemoryDatabaseHarness } from "../test/inMemoryDatabasePlugin";
import { startHttpTestServer } from "./httpTestServer";
import { setupDatabasePluginTestSuite } from "./setupDatabasePluginTestSuite";

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
