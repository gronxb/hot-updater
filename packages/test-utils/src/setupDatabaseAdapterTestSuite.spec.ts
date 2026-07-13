import { createInMemoryDatabaseHarness } from "../test/inMemoryDatabaseAdapter";
import { setupDatabaseAdapterTestSuite } from "./setupDatabaseAdapterTestSuite";

const harness = createInMemoryDatabaseHarness();

setupDatabaseAdapterTestSuite({
  name: "in-memory database adapter",
  createAdapter: () => harness.adapter,
  migrate: () => undefined,
  reset: () => harness.reset(),
  dispose: () => undefined,
  capabilities: { transaction: true },
});
