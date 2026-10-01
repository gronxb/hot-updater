import { createKvAdapter } from "@hot-updater/plugin-core";
import * as engine from "@hot-updater/plugin-core/internal";
import {
  setupAggregateBatchingTestSuite,
  createMemoryKeyValueStore,
} from "@hot-updater/test-utils";

/** The key-value helper over the in-memory store, whose writes take 100 items as DynamoDB's do. */
setupAggregateBatchingTestSuite({
  name: "key-value (in-memory store)",
  engine,
  createAdapter: async () => ({
    adapter: createKvAdapter({ store: createMemoryKeyValueStore() }),
  }),
  oversizedRows: 150,
});
