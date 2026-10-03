import { createKvAdapter } from "@hot-updater/plugin-core";
import {
  setupDatabaseAdapterConformanceSuite,
  createMemoryKeyValueStore,
} from "@hot-updater/test-utils";

setupDatabaseAdapterConformanceSuite({
  name: "key-value (in-memory store)",
  // The store takes 100 items per write, and a conformance insert is 3: a
  // row and 2 index items. 33 inserts fit; 34 are 102 items.
  maxOps: 33,
  // Rows of a table with retention carry a TTL the store deletes them by.
  retention: "ttl",
  createAdapter: async ({ nativePageSize }) => ({
    adapter: createKvAdapter({
      store: createMemoryKeyValueStore({ nativePageSize }),
      tablePrefix: "t_",
    }),
  }),
});
