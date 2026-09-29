import { createMemoryAdapter } from "@hot-updater/plugin-core/internal";

import { setupDatabaseAdapterConformanceSuite } from "./setupDatabaseAdapterConformanceSuite";

/** The reference adapter as `createMemoryAdapter` makes it: no write cap. */
setupDatabaseAdapterConformanceSuite({
  name: "memory",
  createAdapter: async ({ tables, nativePageSize }) => {
    const adapter = createMemoryAdapter({ nativePageSize });
    await adapter.migrations?.apply(tables);
    return { adapter };
  },
});
