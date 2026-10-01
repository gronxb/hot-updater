import { createMemoryAdapter } from "@hot-updater/plugin-core";
import { setupReadBudgetTestSuite } from "@hot-updater/test-utils";

/** The reference adapter, with the native page size the suite sets. */
setupReadBudgetTestSuite({
  name: "memory",
  createAdapter: async ({ nativePageSize }) => ({
    adapter: createMemoryAdapter({ nativePageSize }),
  }),
});
