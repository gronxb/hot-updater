import { createMemoryAdapter } from "@hot-updater/plugin-core";
import {
  setupReadBudgetTestSuite,
  setupReleaseLabelEngineTestSuite,
  type ReadBudgetSuiteOptions,
} from "@hot-updater/test-utils";

/** The reference adapter, which reads each page whole. */
const backend: ReadBudgetSuiteOptions = {
  name: "memory",
  createAdapter: async () => ({ adapter: createMemoryAdapter() }),
};
setupReadBudgetTestSuite(backend);
setupReleaseLabelEngineTestSuite(backend);
