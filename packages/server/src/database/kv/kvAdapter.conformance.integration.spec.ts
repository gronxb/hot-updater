import { setupDatabaseAdapterConformanceSuite } from "@hot-updater/test-utils";

import { createKvAdapter } from "./kvAdapter";
import { createMemoryKeyValueStore } from "./kvTestStore";

setupDatabaseAdapterConformanceSuite({
  name: "key-value (in-memory store)",
  // The store takes 100 items per write, and a conformance insert is 3: a
  // row and 2 index items. 33 inserts fit; 34 are 102 items.
  maxOps: 33,
  createAdapter: async ({ nativePageSize }) => ({
    adapter: createKvAdapter({
      store: createMemoryKeyValueStore({ nativePageSize }),
      tablePrefix: "t_",
    }),
  }),
});
