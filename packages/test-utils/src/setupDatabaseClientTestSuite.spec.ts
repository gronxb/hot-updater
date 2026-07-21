import { createInMemoryDatabaseClient } from "../test/inMemoryDatabaseClient";
import { createInMemoryDatabaseHarness } from "../test/inMemoryDatabasePlugin";
import { setupDatabaseClientTestSuite } from "./setupDatabaseClientTestSuite";

const harness = createInMemoryDatabaseHarness();

setupDatabaseClientTestSuite({
  name: "in-memory database aggregate client",
  createPlugin: () => harness.plugin,
  createClient: createInMemoryDatabaseClient,
  migrate: () => undefined,
  reset: () => harness.reset(),
  dispose: () => undefined,
});
