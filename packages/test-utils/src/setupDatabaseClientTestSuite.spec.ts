import { createInMemoryDatabaseHarness } from "../test/inMemoryDatabaseAdapter";
import { createInMemoryDatabaseClient } from "../test/inMemoryDatabaseClient";
import { setupDatabaseClientTestSuite } from "./setupDatabaseClientTestSuite";

const harness = createInMemoryDatabaseHarness();

setupDatabaseClientTestSuite({
  name: "in-memory database aggregate client",
  createAdapter: () => harness.adapter,
  createClient: createInMemoryDatabaseClient,
  migrate: () => undefined,
  reset: () => harness.reset(),
  dispose: () => undefined,
});
