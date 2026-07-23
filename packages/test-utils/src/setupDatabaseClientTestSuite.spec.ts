import { createInMemoryDatabaseClient } from "../test/inMemoryDatabaseClient";
import { createInMemoryDatabaseHarness } from "../test/inMemoryDatabasePlugin";
import { setupDatabaseClientTestSuite } from "./setupDatabaseClientTestSuite";

const harness = createInMemoryDatabaseHarness();
const sequentialHarness = createInMemoryDatabaseHarness();

setupDatabaseClientTestSuite({
  name: "in-memory database aggregate client",
  createPlugin: () => harness.plugin,
  createClient: createInMemoryDatabaseClient,
  migrate: () => undefined,
  reset: () => harness.reset(),
  dispose: () => undefined,
});

setupDatabaseClientTestSuite({
  name: "in-memory sequential database aggregate client",
  createPlugin: () => {
    const { transaction: ignoredTransaction, ...plugin } =
      sequentialHarness.plugin;
    void ignoredTransaction;
    return plugin;
  },
  createClient: createInMemoryDatabaseClient,
  migrate: () => undefined,
  reset: () => sequentialHarness.reset(),
  dispose: () => undefined,
});
