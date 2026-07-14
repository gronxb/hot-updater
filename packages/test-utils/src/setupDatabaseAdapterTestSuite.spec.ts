import { afterAll, expect, vi } from "vitest";

import { createInMemoryDatabaseHarness } from "../test/inMemoryDatabaseAdapter";
import { setupDatabaseAdapterTestSuite } from "./setupDatabaseAdapterTestSuite";

const harness = createInMemoryDatabaseHarness();
const transaction = vi.spyOn(harness.adapter, "transaction");

setupDatabaseAdapterTestSuite({
  name: "in-memory database adapter",
  createAdapter: () => harness.adapter,
  migrate: () => undefined,
  reset: () => harness.reset(),
  dispose: () => undefined,
});

afterAll(() => {
  expect(transaction).toHaveBeenCalledTimes(2);
});
