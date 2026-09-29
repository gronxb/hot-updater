import { setupReadBudgetTestSuite } from "@hot-updater/test-utils";

import { readBudgetServer } from "../../readBudgets.testFixtures";
import { createKvAdapter } from "./kvAdapter";
import { createMemoryKeyValueStore } from "./kvTestStore";

/** The key-value helper over the in-memory store, whose writes take 100 items as DynamoDB's do. */
setupReadBudgetTestSuite({
  name: "key-value (in-memory store)",
  server: readBudgetServer,
  createAdapter: async ({ nativePageSize }) => ({
    adapter: createKvAdapter({
      store: createMemoryKeyValueStore({ nativePageSize }),
    }),
    indexCopies: true,
  }),
});
