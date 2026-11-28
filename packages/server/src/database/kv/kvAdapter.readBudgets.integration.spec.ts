import { createKvAdapter } from "@hot-updater/plugin-core";
import {
  setupReadBudgetTestSuite,
  createMemoryKeyValueStore,
  setupReleaseLabelEngineTestSuite,
  type ReadBudgetSuiteOptions,
} from "@hot-updater/test-utils";

/** The key-value helper over the in-memory store, whose writes take 100 items as DynamoDB's do. */
const backend: ReadBudgetSuiteOptions = {
  name: "key-value (in-memory store)",
  createAdapter: async ({ nativePageSize }) => ({
    adapter: createKvAdapter({
      store: createMemoryKeyValueStore({ nativePageSize }),
    }),
    indexCopies: true,
  }),
};
setupReadBudgetTestSuite(backend);
setupReleaseLabelEngineTestSuite(backend);
