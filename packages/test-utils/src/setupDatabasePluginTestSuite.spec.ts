import { afterAll, expect, vi } from "vitest";

import { createInMemoryDatabaseHarness } from "../test/inMemoryDatabasePlugin";
import { setupDatabasePluginTestSuite } from "./setupDatabasePluginTestSuite";

const harness = createInMemoryDatabaseHarness();
const transaction = vi.spyOn(harness.plugin, "transaction");

setupDatabasePluginTestSuite({
  name: "in-memory database plugin",
  createPlugin: () => harness.plugin,
  migrate: () => undefined,
  reset: () => harness.reset(),
  dispose: () => undefined,
});

afterAll(() => {
  expect(transaction).toHaveBeenCalledTimes(2);
});
