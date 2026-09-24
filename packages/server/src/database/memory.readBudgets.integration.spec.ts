import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";
import { setupReadBudgetTestSuite } from "@hot-updater/test-utils";

import { readBudgetServer } from "../readBudgets.testFixtures";

/** The reference adapter, with the native page size the suite sets. */
setupReadBudgetTestSuite({
  name: "memory",
  server: readBudgetServer,
  createAdapter: async ({ nativePageSize }) => ({
    adapter: createMemoryAdapter({ nativePageSize }),
  }),
});
