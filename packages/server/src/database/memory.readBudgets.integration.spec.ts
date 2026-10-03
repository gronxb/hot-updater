import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { setupReadBudgetTestSuite } from "@hot-updater/test-utils";

/** The reference adapter, which reads each page whole. */
setupReadBudgetTestSuite({
  name: "memory",
  createAdapter: async () => ({ adapter: createMemoryAdapter() }),
});
