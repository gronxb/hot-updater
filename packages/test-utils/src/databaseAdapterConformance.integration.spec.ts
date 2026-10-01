import { createMemoryAdapter } from "@hot-updater/plugin-core";

import { setupDatabaseAdapterConformanceSuite } from "./setupDatabaseAdapterConformanceSuite";

/** The reference adapter as `createMemoryAdapter` makes it: no write cap. */
setupDatabaseAdapterConformanceSuite({
  name: "memory",
  createAdapter: async ({ tables }) => {
    const adapter = createMemoryAdapter();
    await adapter.migrations?.apply(tables);
    return { adapter };
  },
});
