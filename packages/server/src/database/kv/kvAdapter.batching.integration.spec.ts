import { setupAggregateBatchingTestSuite } from "@hot-updater/test-utils";

import * as engine from "../index";
import { createKvAdapter } from "./kvAdapter";
import { createMemoryKeyValueStore } from "./kvTestStore";

/** The key-value helper over the in-memory store, whose writes take 100 items as DynamoDB's do. */
setupAggregateBatchingTestSuite({
  name: "key-value (in-memory store)",
  engine,
  createAdapter: async () => ({
    adapter: createKvAdapter({ store: createMemoryKeyValueStore() }),
  }),
  oversizedRows: 150,
});
