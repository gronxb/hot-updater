import { createInMemoryDatabaseHarness } from "../test/inMemoryDatabasePlugin";
import { setupDatabasePluginTestSuite } from "./setupDatabasePluginTestSuite";

const harness = createInMemoryDatabaseHarness();

setupDatabasePluginTestSuite({
  name: "in-memory database plugin",
  createPlugin: () => harness.plugin,
  migrate: () => undefined,
  reset: () => harness.reset(),
  dispose: () => undefined,
});
